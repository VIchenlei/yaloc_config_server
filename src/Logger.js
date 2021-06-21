import mysql from './MysqlWraper.js'

export default class Logger {
  constructor () { // eslint-disable-line
  }

  /**
   * 将操作流水记录至 DB 中
   *
   * @method log2db
   *
   * @param  {[type]} socket     [description]
   * @param  {[type]} op_type_id [description]
   * @param  {[type]} detail     [description]
   *
   * @return {[type]}            [description]
   */
  static async log2db (socket, opTypeID, detail) {
    let userInfo = socket.handshake.session.user
    let userID = userInfo.name
    let ip = socket.request.connection.remoteAddress || socket.request.connection.localAddress
      // execute update on db
    let sql = `insert into his_op_log (op_type_id, user_id, op_time, ip, detail) values(${opTypeID},'${userID}', '${new Date().format('yyyy-MM-dd hh:mm:ss')}', '${ip}', '${detail}')`

    try {
      let rows = await mysql.query(sql)  // eslint-disable-line
    } catch (err) {
      console.error(`记录日志至DB失败 : \n\t SQL : ${sql} \n\t ${err}`)
    }
  }
}
