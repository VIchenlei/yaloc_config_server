import Logger from './Logger.js'
import mysql from './MysqlWraper.js'

let metaDefinition = require('./meta_definition.js')
let config = require('./config/appconfig.js')
let eventTag = 'META'
const DATABLENAME = 'dat_mdt_update'

const opType = {
  'UPDATE': '更新',
  'INSERT': '添入',
  'DELETE': '删除'
}

export default class Meta {
  constructor(reportFile, workers) { // eslint-disable-line
    this.reportFile = reportFile
    this.workers = workers
  }

  dispatch (socket, req) {
    if (!req) return
    switch (req.cmd) {
      case 'meta_data':
        let def = metaDefinition[req.data.name]
        this.sendMetaData(socket, def)
        break
      case 'pull_msg':
        let pullDef = metaDefinition[req.tablename]
        this.sendMetaData(socket, pullDef)
        break
      case 'update':
        // 这里虽然调用了 async function ，但因为无需等待其返回结果，所以不需要使用 await。
        // 这里相当于提交请求，具体的处理逻辑就都在处理函数中来完成。
        this.updateDB(socket, req)
        break
      case 'afresh_metadata':
        this.afreshSendMetadata(socket, req)
        break
      case 'pull_down_metadata':
        this.pullDownMetadata(socket, req)
        break
      default:
        console.warn(`未知的META请求：${req.cmd}`)
        break
    }
  }

  sendUpdateDBErrorRes (socket, req, err) {
    let errMsg = `更新数据库失败，请联系系统管理员处理。`
    err = err.message
    console.error(`更新数据库失败 : \n\t SQL : ${req.data.sql} \n\t ${err}`)

    if (/his_leader_arrange/.test(req.data.name) && err.includes('PRIMARY')) {
      let keyValue = err.split("'")[1] // 主键拼接信息 staff_id-shift_id-duty_date 
      let keyValueArray = keyValue.split("-")
      errMsg = `员工编号:${keyValueArray[0]};班次:${keyValueArray[1]};代班日期:${keyValueArray[2]}-${keyValueArray[3]}-${keyValueArray[4]}已存在`
    }

    let resMsg = {
      code: -1,
      msg: errMsg,
      cmd: req.cmd,
      data: {
        op: req.data.op,
        name: req.data.name,
        id: req.data.id
      }
    }
    this.sendMetaMessage(socket, resMsg)
  }

  async getSql (sql, req) {
    let msg = {}
    if (typeof sql === 'object') {
      let keys = Object.keys(sql)
      let promise = []
      for (let i = 0; i < keys.length; i++) {
        let row = await mysql.query(sql[keys[i]])
        promise.push(row)
      }
      let rows = Promise.all(promise).then((results) => {
        keys.forEach(key => {
          let index = keys.indexOf(key)
          msg[key] = results[index]
        })
      }).catch((err) => {
        console.log('err<<<<<<<<<<<<<', err)
      })
      return rows
    } else {
      let rows = await mysql.query(sql)
      return rows
    }
  }

  /**
   * 更新 metadata DB
   *
   * @method
   *
   * @param  {[type]} socket [description]
   * @param  {[type]} req    [description]
   *      req = {
              cmd: db_op, // INSERT, UPDATE, DELETE
              data: {
                  name: tdd.name,
                  id: id,
                  sql: sqlstring
              }
          }
    * @return {[type]}        [description]
    */
  async updateDB (socket, req) {
    // execute update on db
    let sql = req.data.sql
    let rows = null // eslint-disable-line

    let updateSQLtime = new Date().format('yyyy-MM-dd hh:mm:ss')
    let mdtSql = null
    let cardMdtSql = null
    let timename = null
    let tablename = `dat_${req.data.name}`
    let updateArr = req.data.updateArr
    let deptArr = req.data.deptArr
    let emptySql = req.data.emptySql
    if (req.data.op === 'DELETE') {
      timename = 'lastDelete'
      mdtSql = `UPDATE ${DATABLENAME} SET lastDelete = '${updateSQLtime}' where tableName = '${tablename}'`
    } else {
      timename = 'lastUpdate'
      mdtSql = `UPDATE ${DATABLENAME} SET lastUpdate = '${updateSQLtime}' where tableName = '${tablename}'`
      if (sql.card_sql) {
        cardMdtSql = `UPDATE ${DATABLENAME} SET lastUpdate = '${updateSQLtime}' where tableName = 'dat_card'`
      }
    }
    // console.log('<<<<<<<<<<<<<<<<<<<<<<<<<', mdtSql)
    try {
      if (emptySql) {
        rows = await mysql.query(emptySql)
        if (rows) {
          rows = await this.getSql(sql, req)
        }
      } else {
        rows = await this.getSql(sql, req)
      }
      // console.log('---打印rows', rows)
      if (updateArr) {
        for (let i = 0; i < updateArr.length; i++) {
          await mysql.query(`REPLACE into rpt_sanlv_daily_detail (MainID,work_face_id,Analysis) VALUES (${rows.insertId},${deptArr[i]},'${updateArr[i]}')`)
        }
      }

      if (metaDefinition[req.data.name]) {
        await mysql.query(mdtSql)
        cardMdtSql && await mysql.query(cardMdtSql)
      }
    } catch (err) {
      this.sendUpdateDBErrorRes(socket, req, err)
      return
    }

    // 将成功结果返回。
    let resMsg = null // 应答数据
    resMsg = {
      code: 0,
      msg: sql,
      cmd: req.cmd,
      data: {
        op: req.data.op,
        name: req.data.name,
        id: req.data.id
      },
      mdtdata: {
        timename: timename,
        time: updateSQLtime
      }
    }
    this.sendMetaMessage(socket, resMsg)
    this.broadcastMetaData(socket, config.STANDBY, metaDefinition[req.data.name], req.data.op)

    let type = opType[req.data.op]
    let dataName = metaDefinition[req.data.name] ? metaDefinition[req.data.name].label : req.data.name
    let opTypeID = 2
    let dataID = req.data.detail ? req.data.detail : req.data.id
    let detail = `web Tool${type}.${dataName}-${dataID}`.slice(0, 1023) // 避免字节长度超出导致添加录入数据库失败
    !/leader_arrange/.test(req.data.name) && Logger.log2db(socket, opTypeID, detail)
  }

  async getMetaData (def, mdtcondition) {
    //  debugger
    let fstring = ''

    let names = def.fields.names
    let index = names.indexOf('geom')
    if (index >= 0) {
      // 需要修改 names，先复制一份
      names = [...def.fields.names]
      names[index] = 'ASTEXT(geom) as geom'
    }
    fstring = names.join(',')

    let condition = ''
    if (def.name === 'driver_arrange') {
      let today = new Date().format('yyyy-MM-dd')
      condition = `where driver_date = '${today}'`
    } else if (mdtcondition) {
      condition = mdtcondition
    }

    let sql = `select ${fstring} from ${def.table} ${condition};`
    let rows = null
    try {
      rows = await mysql.query(sql)
    } catch (err) {
      console.warn('查询 META DB 失败！ \n', err)
    }
    // console.log('rows are ' + rows)
    return rows // Here the 'rows' will converted to be  Promise.resolve(rows)
  }

  composeMetaMessage (def, rows, upMethod) {
    let message = null
    if (rows && rows.length > 0) {
      // JSON中，定义属性的方式有两种：一种是o.f，另外一种是o[f]。第一种f不能为变量，第二种f可以为变量.
      message = {
        code: 0,
        msg: 'OK',
        cmd: 'meta_data',
        upMethod: upMethod,
        data: {
          name: def.name,
          key: def.fields.names[def.keyIndex],
          rows: rows
        }
      }
    } else {
      message = {
        code: 0,
        msg: '没有符合条件的记录。',
        cmd: 'meta_data',
        data: {
          name: def.name
        }
      }
    }

    return message
  }

  pullDownMetadata (socket, req) {
    let mdtdata = req.data.mdtdata
    if (mdtdata.length > 0) {
      this.checkTableTime(socket, mdtdata)
    } else {
      let promises = this.sendAllMetaData(socket) // 发送所有数据
      Promise.all(promises).then(() => {
        let msg = {
          code: 0,
          cmd: 'meta_data_all'
        }
        this.sendMetaMessage(socket, msg)
      }).catch((err) => {
        console.log(`>>>> Send all meta data FAILED.\n`, err)
      })
    }
  }

  checkoutTime (value, row, name, socket) {
    if (row) {
      row = row[0]
      let newDeleteTime = row.lastDelete && new Date(row.lastDelete).getTime() // 数据表中的最后删除时间
      let oldDeleteTime = value.lastDelete && new Date(value.lastDelete).getTime() // indexDB中最后删除时间

      let newLastUpdate = row.lastUpdate && new Date(row.lastUpdate).getTime() // 数据表中的最后更新时间
      let oldLastUpdate = value.lastUpdate && new Date(value.lastUpdate).getTime() // indexDB中的最后更新时间

      if (newDeleteTime > oldDeleteTime) { // 全量更新
        this.sendMetaData(socket, metaDefinition[name], null, 'DELETE')
      } else if (newLastUpdate > oldLastUpdate) { // 批量更新
        // let condition = `where lastUpdate >= '${value.lastUpdate}'`
        // this.sendMetaData(socket, metaDefinition[name], condition)
        this.sendMetaData(socket, metaDefinition[name], null, 'DELETE')
      }
    }
  }

  async checkTableTime (socket, rows) {
    let key = metaDefinition['mdt_update']
    let mdtrows = await this.getMetaData(key)
    for (let i = 0, len = rows.length; i < len; i++) {
      let value = rows[i] // 客户端数据
      let tablename = value.tableName
      let name = tablename.slice(4)
      let row = mdtrows.filter(item => item.tableName === tablename) // 数据表数据
      this.checkoutTime(value, row, name, socket)
    }
  }

  // 强制更新元数据
  afreshSendMetadata (socket, def) {
    let promises = this.sendDataTable(socket) // 发送meta_dat中的数据，基础表更新或删除
    Promise.all(promises).then(() => {
      console.log(`>>>> Send all meta data DONE.`)
    }).catch((err) => {
      console.log(`>>>> Send all meta data FAILED.\n`, err)
    })
  }

  /**
   * [sendMetaData description]
   *
   * @method sendMetaData
   *
   * @param  {[type]}     meta_def [description]
   *
   * @return {[type]}              [description]
   */
  async sendMetaData (socket, def, condition, upMethod) {
    // debugger
    // 这里需要等待 getMetaData 返回才能执行后续的逻辑，所以要使用 await
    let rows = await this.getMetaData(def, condition)
    let message = this.composeMetaMessage(def, rows, upMethod)
    if (socket === null) {
      return message
    }
    this.sendMetaMessage(socket, message)
    console.log(`meta: ${def.name}, count: ${rows ? rows.length : 0}`)
  }

  sendDataTable (socket) {
    let promises = []
    let sendTable = ['mdt_update', 'user', 'driver_arrange', 'user_tool']
    for (let i = 0; i < sendTable.length; i++) {
      let key = sendTable[i]
      let p = this.sendMetaData(socket, metaDefinition[key])
      promises.push(p)
    }

    return promises
  }

  sendAllMetaData (socket) {
    let promises = []
    for (let key in metaDefinition) {
      if (key !== 'mdt_update') {
        let p = this.sendMetaData(socket, metaDefinition[key])
        promises.push(p)
      }
    }

    return promises
  }

  async sendAllMetaDataForMetaStoreOnServer () {
    let res = []
    for (let key in metaDefinition) {
      let msg = await this.sendMetaData(null, metaDefinition[key])
      // console.log(JSON.stringify(msg))
      res.push(msg)
    }
    // console.log(res)
    return res
  }

  sendMetaMessage (socket, message) {
    console.log('-----------------', message.cmd)
    socket.emit(eventTag, message)
  }

  /**
   * Broadcast the meta data to ALL clients in the config.STANDBY room
   * @param {*} socket the client connection
   * @param {*} room  the room
   * @param {*} eventTag event tag
   * @param {*} message  message
   */
  broadcastMessage (socket, room, eventTag, message) {
    // socket.to(room)  == socket.broadcast.to(room)
    // socket.broadcast.to(room) 向 room 广播，不包括自己
    // socket.broadcast.emit('user connected')  向 socket 所在的 room 广播，不包括自己
    // this.socket.to(room).emit(etag, message)  // 无法发送给 socket 自己

    // io.emit('this', { will: 'be received by everyone'})
    // io.sockets.in(room) 向 room 广播，包括自己

    // 如何通过 socket 获得对应的 io 对象？
    // socket.server === io
    // console.log(' == broadcast == \n ', message)
    // socket.server.sockets.in(room).emit(eventTag, message)
    socket.server.sockets.emit(eventTag, message) // 向所有用户广播，包括自己
    // socket.broadcast.emit('PUSH', message) // 只广播给其他用户
  }

  async broadcastMetaData (socket, room, metaDef, upMethod) {
    // debugger
    // console.log(' == broadcastMetaData == ENTER')
    let rows = await this.getMetaData(metaDef)
    // console.log(' == broadcastMetaData == await done')

    let message = this.composeMetaMessage(metaDef, rows, upMethod)
    this.broadcastMessage(socket, room, eventTag, message)
  }

  sendMetaDefinition (socket) {
    if (socket === null) {
      // console.log('metaDefinition is ' + JSON.stringify(metaDefinition))
      return metaDefinition
    }

    let message = {
      cmd: 'meta_definition',
      data: metaDefinition,
      length: Object.keys(metaDefinition).length
    }
    console.log('>>>>>>>>>>>>' + message.length)
    this.sendMetaMessage(socket, message)
  }
}
