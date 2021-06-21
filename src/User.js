// logic : there is a new socket, there is a new user.
import Utils from './Utils.js'
import Logger from './Logger.js'
import XFiler from './XFile.js'
import Meta from './Meta.js'
import mysql from './MysqlWraper.js'
import Report from './Report.js'
let config = require('./config/appconfig.js')

export default class User {
  constructor (io, userlist, metaStore, socket, reportFile, workers) {
    if (socket) {
      this.userlist = userlist
      this.socket = null
      this.session = null
      this.callback = new Map()

      this.io = io
      this.bind(socket)

      this.name = null // user's name
      this.type = null // collector, monitor
      this.workers = workers

      this.meta = new Meta(reportFile, workers)
      this.filer = new XFiler()
      this.metaStore = metaStore
      this.reportFile = reportFile
      this.report = new Report(this, metaStore)
    } else {
      console.warn('无可用连接！')
    }
  }

  // 监控端登录时，PUSH 采集服务器的状态
  sendCollectorStatus () {
    let collector = this.userlist.get(config.COLLECTOR)

    let status = collector && collector.socket && collector.socket.auth ? 'online' : 'offline'
    let message = {
      cmd: 'collector_status',
      data: {
        status: status,
        time: new Date()
      }
    }

    this.socket.emit('PUSH', message)
  }

  // 采集服务器状态变化时，广播状态
  // 注意，采集server logout 的时候，不广播，直接通过 socket 的 disconncet 事件广播
  broadcastCollectorStatus (status) {
    let message = {
      cmd: 'collector_status',
      data: {
        status: status,
        time: new Date()
      }
    }

    this.io.to(config.MONITOR).emit('PUSH', message)
  }

  sendThreeRate (data) {
    console.log('data----------------------', data)
  }

  registerEventHandler (socket) {
    if (!socket) {
      console.warn('注册事件处理器失败：没有可用的网络连接！')
      return
    }

    socket.on('disconnect', (req) => {
      console.log(`USER ${this.name} disconnected.`)

      if (this.name === config.COLLECTOR) {
        this.broadcastCollectorStatus('offline')
      }
    })

    socket.on('USER', (req, callback) => {
      console.log(`Got USER message : \n\t${JSON.stringify(req)}`)

      req = Utils.toJson(req)
      if (!req) {
        console.warn('Invalid request.', req)
        return
      }
      switch (req.cmd) {
        case 'login':
          this.login(req, callback)
          break
        case 'logout':
          this.logout(req, callback)
          break
        case 'standby':
          this.standby(req, callback)
          break
        case 'modify':
          this.modify(req, callback)
          break
        default:
          console.warn(`未知的 USER 请求：${req.cmd}`)
          break
      }
    })

    socket.on('FILE', (req) => {
      // console.log(`Got FILE message : \n\t${JSON.stringify(req)}`)

      req = Utils.toJson(req)
      this.filer.dispatch(socket, req)
    })

    socket.on('META', (req) => {
      // console.log(`Got META message : \n\t${JSON.stringify(req)}`)
      req = Utils.toJson(req)
      if (!req) {
        console.warn('Invalid request.', req)
        return
      }

      if (!socket.auth) {
        let userID = req.username
        console.log('this.socket:::::::::', socket.handshake.session.user.name, userID)
        if (socket.handshake.session.user.name === userID) {
          socket.auth = true
        }
      }

      if (socket.auth) {
        this.meta.dispatch(this.socket, req)
      } else {
        this.notLogin('META')
      }
    })

    socket.on('REPT', (req, callback) => {
      // console.log(`Got META message : \n\t${JSON.stringify(req)}`)
      req = Utils.toJson(req)
      if (!req) {
        console.warn('Invalid request.', req)
        return
      }

      if (!socket.auth) {
        let userID = req.username
        console.log('this.socket:::::::::', socket.handshake.session.user.name, userID)
        if (socket.handshake.session.user.name === userID) {
          socket.auth = true
        }
      }

      if (socket.auth) {
        this.callback.set(req.key, callback)
        req.cmd === 'query' ? this.reportFile.doQueryData(req, callback) : this.report.dispatch(this.socket, req, callback)
      } else {
        this.notLogin('REPT')
      }
    })

    socket.on('PULLMSG', (req) => {
      req = Utils.toJson(req)
      if (!req) {
        console.warn('Invalid request.', req)
        return
      }

      if (!socket.auth) {
        let userID = req.username
        console.log('this.socket:::::::::', socket.handshake.session.user.name, userID)
        if (socket.handshake.session.user.name === userID) {
          socket.auth = true
        }
      }

      if (socket.auth) {
        this.meta.dispatch(this.socket, req)
      } else {
        this.notLogin('META')
      }
    })
  }

  notLogin (cmd) {
    let res = {
      code: -100,  // -100, 表示尚未登录
      msg: `${cmd} : 用户 ${this.name} 尚未登录！`,
      data: {
        username: this.name
      }
    }

    // info the client
    this.socket.emit('USER', res)
    console.warn(res.msg)
  }

  doCallBack (fn, msg, remark) {
    if (fn && typeof fn === 'function') {
      fn(msg)
      console.debug(`${remark} : callback is done. callback=${fn}, msg=${msg}`)
    } else {
      console.warn(`${remark} : callback is invalid. callback=${fn}, msg=${msg}`)
    }
  }

  /**
   * login processor
   *
   * @method login
   *
   * @param  {[type]}   req      [login message]
   * @param  {Function} callback [callback the client's processor]
   *
   */
  async login (req, callback) {
    let resMsg = null

    let userName = req.data.user_name
    let userPass = req.data.user_pass
    // userPass = Utils.sha1(userPass)
    let sql = `select user_tool_id, role_id from dat_user_tool where user_tool_id="${userName}" and pwd="${userPass}"`
    // console.log('sql', sql)
    let rows = null

    try {
      console.log('Going to do login-check on DB， please wait... ', userName)
      rows = await mysql.query(sql)
      // console.log('rows-----------------', rows)
      console.log('Login-check on DB done. ', userName)
    } catch (err) {
      console.error(`查询DB失败。 \n\t ${err}`)
      resMsg = {
        code: -1,
        msg: '服务器错误，请联系系统管理员！',
        data: {
          name: userName
        }
      }
      this.doCallBack(callback, resMsg, 'User.login')

      return
    }

    if (rows && rows.length > 0) { // loged in
      this.socket.auth = true
      this.session.user = {
        // name: rows[0].user_id,
        name: userName,
        roleID: rows[0].role_id,
        ip: this.socket.request.connection.remoteAddress || this.socket.request.connection.localAddress || this.socket.handshake.address
      }
      this.session.save() // save the session info to sessionStore
      this.initContext(userName, req)
      Logger.log2db(this.socket, 0, '登录web Tool成功！')

      resMsg = {
        code: 0,
        msg: '',
        data: {
          name: userName,
          roleID: rows[0].role_id,
          sid: this.socket.handshake.sessionID,
          ip: this.socket.request.connection.remoteAddress || this.socket.request.connection.localAddress || this.socket.handshake.address
        }
      }

      // info all connections
      if (this.name === config.COLLECTOR) {
        this.broadcastCollectorStatus('online')
      } else {
        // 只发给刚登录的用户
        this.sendCollectorStatus()
      }
    } else {
      console.log('ERROR: 用户名或密码错误: ' + this.name)
      resMsg = {
        code: -1,
        msg: '用户名或密码错误，请确认后再试。'
      }
    }

    this.doCallBack(callback, resMsg, 'User.login')
  }

  /**
   * 退出登录态
   * socket 退出对应的房间。
   * 注意，这时 client / browser 与 server 之间的 socket 并没有断开。
   *
   * @method doLogout
   *
   * @param  {[type]} socket    [description]
   * @param  {[type]} event_tag [description]
   * @param  {[type]} req       [description]
   *
   * @return {[type]}           [description]
   */
  logout (req, callback) {
    // let resMsg = null

    let userInfo = this.session.user
    if (userInfo) {
      let userName = userInfo.name
      Logger.log2db(this.socket, 1, '退出web Tool成功！')

      this.clearContext(userName)

      delete this.socket.handshake.session.user
      this.socket.auth = false
      if (this.name === config.COLLECTOR) {
        this.broadcastCollectorStatus('offline')
      }

      this.name = null
    }
  }

  standby (req, callback) {
    let userName = req.data.username
    let resMsg = null
    if (req.data.op === 'enter') {
      this.socket.leave(config.MONITOR)
      console.log(`>> User ${userName} leave ${config.MONITOR}`)
      this.socket.join(config.STANDBY)
      console.log(`>> User ${userName} enter ${config.STANDBY}`)

      resMsg = {
        code: 0,
        op: req.data.op
      }
    } else if (req.data.op === 'leave') {
      this.socket.leave(config.STANDBY)
      console.log(`>> User ${userName} leave ${config.STANDBY}`)
      this.socket.join(config.MONITOR)
      console.log(`>> User ${userName} enter ${config.MONITOR}`)

      resMsg = {
        code: 0,
        op: req.data.op
      }
    } else {
      resMsg = {
        code: -1,
        op: req.data.op
      }
      console.warn('UNKNOWN standby command : ', req.cmd)
    }

    this.doCallBack(callback, resMsg, 'User.standby')
  }

  async modify (req, callback) {
    let resMsg = null

    let username = req.data.username
    let oldpwd = req.data.oldpwd
    // oldpwd = Utils.sha1(oldpwd)

    let newpwd = req.data.newpwd
    // newpwd = Utils.sha1(newpwd)

    let sql = `select user_tool_id from dat_user_tool where user_tool_id="${username}" and pwd="${oldpwd}"`

    let rows = null
    try {
      rows = await mysql.query(sql)
    } catch (err) {
      console.error(`查询DB失败。 \n\t ${err}`)
      resMsg = {
        code: -1,
        msg: '服务器错误，请联系系统管理员！',
        data: {
          name: username
        }
      }
      this.doCallBack(callback, resMsg, 'User.modify')
      return
    }

    // console.log(`Modify password : \n sql : ${sql} \n rows : `, rows)

    if (rows && rows.length > 0) { // loged in
      sql = `update dat_user_tool set pwd="${newpwd}" where user_tool_id="${username}"`
      // execute update on db
      rows = null
      try {
        rows = await mysql.query(sql)
      } catch (err) {
        console.error(`更新数据库失败 : \n\t SQL : ${sql} \n\t ${err}`)

        resMsg = {
          code: -1,
          msg: '更新数据库失败',
          cmd: req.cmd
        }
        this.doCallBack(callback, resMsg, 'User.modify')

        return
      }

      // 更新 DB 成功
      resMsg = {
        code: 0,
        msg: ''
      }
      Logger.log2db(this.socket, 3, '修改web Tool密码成功！')
    } else {
      resMsg = {
        code: -1,
        msg: '用户名或密码错误，请确认后再试。'
      }
    }

    this.doCallBack(callback, resMsg, 'User.modify')
  }

  bind (socket) {
    this.socket = socket
    this.session = socket.handshake.session

    this.registerEventHandler(this.socket)
  }

  initContext (userName, req) {
    this.name = userName
    if (userName === config.COLLECTOR) {
      this.type = config.COLLECTOR
      this.socket.join(config.COLLECTOR)
      console.log(`>> User ${userName} enter ${config.COLLECTOR}`)
      // Logger.log2db(this.socket, 3, `User ${userName} enter ${config.COLLECTOR}`)
    } else {
      this.type = config.MONITOR
      this.socket.join(config.MONITOR)
      console.log(`>> User ${userName} enter ${config.MONITOR}`)
      this.meta.sendMetaDefinition(this.socket)
      let promises = this.meta.sendDataTable(this.socket) // 发送meta_dat中的数据，基础表更新或删除，每次登陆时，都先发送到客户端
      Promise.all(promises).then(() => {
        console.log(`>>>> Send all meta data DONE for user ${this.name}.`)
      }).catch((err) => {
        console.log(`>>>> Send all meta data FAILED for user ${this.name}.\n`, err)
      })
    }

    this.userlist.add(this) // save socket for later usage
  }

  clearContext (userName) {
    // leave room
    if (userName === config.COLLECTOR) {
      this.socket.leave(config.COLLECTOR)
      console.log(`<< User ${userName} left ${config.COLLECTOR}`)
      // Logger.log2db(this.socket, 3, `User ${userName} enter ${config.COLLECTOR}`)
    } else {
      this.socket.leave(config.MONITOR)
      console.log(`<< User ${userName} left ${config.MONITOR}`)
    }

    this.userlist.remove(this)
  }
}
