// main.js 用于准备服务器环境并启动服务。
// 重点设置 express 和 socket.io 的 session 共享。
import mysql from './MysqlWraper.js'
import UserList from './UserList.js'
import User from './User.js'
import MetaStore from './MetaStore.js'
import file from './FileWraper.js'
import * as config from './config/appconfig.js'
import ReportFile from './reportFile.js'

let workers = null
// ----------- initializing express-session middleware -----------
let Session = require('express-session')

let SessionFileStore = require('session-file-store')(Session) // use file to store the session data
let sessionStore = new SessionFileStore({
  path: config.FileDir.tmp + '/sessions',
  ttl: config.SESSION_TIMEOUT || 21600 // 默认超时时间为半个小时：30*60
})

let session = Session({
  store: sessionStore,
  secret: config.secret,
  resave: true,
  saveUninitialized: true
})

// ----------- express app -----------
let express = require('express')
let app = express()

// session support
app.use(session)

// process static content
app.use(express.static(config.CLIENT_STATIC_DIR))

// ----------- HTTP server -----------
let http = require('http')
let server = http.createServer(app)
let serverIP = config.ip || '0.0.0.0'
let serverPort = config.port || 8086

// ----------- socket.io app -----------
let io = require('socket.io')(server)
io.set('transports', ['websocket']) // Force to use websocket, which will allow Cross Domain Requests

// https://github.com/oskosk/express-socket.io-session
let sharedsession = require('express-socket.io-session')

// use the express session middleware as a Socket.IO middleware
io.use(sharedsession(session, {
  autoSave: true
}))

// ----------- MetaStore -----------
let metaStore = new MetaStore()
// usernames which are currently connected to the server
let userList = new UserList()
let reportFile = new ReportFile()
// 初始化相关的文件目录
try {
  initFileDirectories()
} catch (error) {
  console.warn('Init file directories FAILED.')
}

io.on('connection', (socket) => {
  console.log('Got a connection, sessionID = ' + socket.handshake.sessionID)
  console.log('当前用户列表：\n', userList)

  // 当一个新连接进来时，可能有以下几种情况：
  // 1. 一个新的用户， session == null；
  // 2. 一个老用户，socket 存在，但已经 logout；
  // 3. 一个老用户，session 已经超时了（相当于logout）；
  // 4. 一个老用户，没有 logout，但因为连接中断，这次是 socket 重新连接；
  // 这里主要要处理第4种情况，从session中获取认证信息，恢复至用户的连接上（socket.handshake.session）
  sessionStore.get(socket.handshake.sessionID, (err, session) => {
    socket.auth = false
    let reqSessionID = socket.handshake.sessionID

    if (err) {
      console.warn(`从 SessionStore 获取 id 为 ${reqSessionID} 的 Session 失败！\n`, err)
    } else {
      if (!session) {
        console.log(`SessionStore 中没有 id 为 ${reqSessionID} 的 session 信息！\n`)
      } else {
        console.log(`SessionStore 中有 id 为 ${reqSessionID} 的 session 信息：\n`, session)

        if (!session.user) {
          console.log('用户已退出 或 session 已超时！')
        } else { // reconnect user
          socket.handshake.session.user = session.user

          let userName = session.user.name
          let user = userList.get(userName)
          if (!user) {
            console.log(`当前用户列表 UserList 中已没有用户 ${userName} 的信息：\n`, userList)
          } else { // 重新连接的用户，且 session 尚未超时，在这里恢复用户对象
            user.bind(socket) // 将新的 socket 绑定到用户对象
            user.initContext(userName)  //

            socket.auth = true
            console.log(`用户 ${userName} 重新连接成功！`)
            printRooms()
          }
        }
      }
    }

    if (!socket.auth) { // 作为新用户，需登录 // TODO 优化逻辑
      console.log('Going to create a new user for the *socket* whose handshake.session = ', socket.handshake.session)
      new User(io, userList, metaStore, socket, reportFile, workers)  // eslint-disable-line
    }
  })
})

/**
 * [printRooms 列出当前系统中的 room 和 连接，用于调试]
 * @return {[type]} [description]
 */
function printRooms () {
  let rooms = io.nsps['/'].adapter.rooms
  for (let room in rooms) {
    if (rooms.hasOwnProperty(room)) {
      // TODO: print the property's name and value
      console.log('room : ', room)
      console.log('\tlist : ', rooms[room])
    // console.log(`room: ${root}, value: ${rooms[room]}`)
    }
  }
  // console.log('Users in MONITOR room : ', io.nsps['/'].adapter.rooms['MONITOR'])
}

// 初始化相关的文件目录，目录定义在 appconfig.js 的 FileDir 中
async function initFileDirectories () {
  let dirs = Object.values(config.FileDir)
  for (let i = 0, count = dirs.length; i < count; i++) {
    let dir = dirs[i]
    try {
      // console.time('CHECK-DIR')
      let exist = await file.dirExist(dir)
      if (!exist) {
        await file.makeDir(dir)
      }
      // console.timeEnd('CHECK-DIR')
    } catch (error) {
      console.warn('Access file system ERROR.', error)
    }
  }
}

const cluster = require('cluster')

async function scanUpdateTime () {
  let mdt = {}
  let rows = null
  let sql = 'SELECT tableName,lastUpdate FROM dat_mdt_update'
  try {
    rows = await mysql.query(sql)
  } catch (err) {
    console.warn('查询 REPT DB 失败！ \n\t', err)
    return
  }
  for (let i = 0; i < rows.length; i++) {
    mdt[rows[i].tableName] = rows[i].lastUpdate
  }
  let updateArr = compareMdt(mdt)
  return updateArr
}

async function compareMdt (updateTables) {
  let updateArr = []
  for (let tablename in updateTables) {
    let lastUpdate = 'lastUpdate'
    // if (tablename === 'rt_person_forbid_down_mine') {
    //   lastUpdate = 'last_update'
    // }
    let searchSql = `SELECT ${lastUpdate} FROM ${tablename} ORDER BY lastUpdate DESC LIMIT 1`
    try {
      let updateTime = await mysql.query(searchSql)
      updateArr.push([tablename, updateTables[tablename], updateTime[0] && updateTime[0].lastUpdate])
      if (updateTime[0] && updateTime[0].lastUpdate !== updateTables[tablename]) {
        let time = new Date(updateTime[0].lastUpdate).format('yyyy-MM-dd hh:mm:ss')
        let updateSql = `UPDATE dat_mdt_update SET lastUpdate='${time}' WHERE tableName='${tablename}'`
        await mysql.query(updateSql)
      }
    } catch (err) {
      console.warn('查询 DB 失败！ \n\t', err)
    }
  }
  return updateArr
}

exports.start = () => {
  if (cluster.isMaster) {
    server.listen(serverPort, serverIP, () => {
      // console.log(`Web server started at ${serverIP}:${serverPort}`)
    })
    // 衍生工作进程。
    workers = cluster.fork()
    cluster.on('exit', (worker, code, signal) => {
      console.log(`工作进程 ${worker.process.pid} 已退出`)
    })
  } else if (cluster.isWorker) {
    console.log(`工作进程 ${process.pid} 已启动`)
    scanUpdateTime()
    setInterval(scanUpdateTime, 10 * 60 * 1000)
  }
}
