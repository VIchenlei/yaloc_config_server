import mysql from './MysqlWraper.js'

export default class ReportFile {
  constructor () {
    this.reportTime = null
    this.timer = null
    this.scards = 0
  }

/**
   * 获取结果集的记录数，用于分页时计算页数。
   */
  async getTotal (sql) {
    let count = 0

    let rows = null
    try {
      rows = await mysql.query(sql)
    } catch (err) {
      console.warn('查询 REPT 记录数失败！ \n\t', err)
    }

    if (rows) {
      let len = rows.length

      if (len === 1) { // sql NOT include 'group by'
        count = rows[0].total
      } else if (len > 1) {  // sql include 'group by'
        count = len
      } else {
        count = 0
      }
    }

    return count
  }

  async getSql (sql, req) {
    let msg = {}
    if (typeof sql === 'object') {
      let keys = Object.keys(sql)
      let promise = []
      keys.forEach(item => {
        promise.push(mysql.query(sql[item]))
      })
      let rows = Promise.all(promise).then((results) => {
        keys.forEach(key => {
          let index = keys.indexOf(key)
          msg[key] = results[index]
        })
        if (req.data.name === 'three-credentials' || req.data.name === 'efficiency_overview') {
          msg['worktime'] = msg['worktime'] || true
        }
        msg['name'] = req.data.name
        return msg
      }).catch((err) => {
        console.log('err<<<<<<<<<<<<<', err)
      })
      return rows
    } else {
      let rows = await mysql.query(sql)
      return rows
    }
  }

  async doQueryData (req, callback) {
    // console.log('REPT : \n ', req)
    let message = null

    // init total
    let total = 0
    total = await this.getTotal(req.data.countSql)
    // adjust sql
    let pageIndex = req.data.pageIndex
    let sql = req.data.sql  // 默认不分页
    let reSql = null
    let pageSize = req.data.pageSize
    if (req.data.pageSize > 0) {  // 如果 pageSize 值有效，则需要分页
      let start = pageSize * pageIndex
      let count = req.data.pageSize
      sql = sql && sql.trim()
      if (sql.endsWith(';')) {  // 去掉末尾的 ';'
        sql = sql.slice(0, sql.length - 1)
      }
      reSql = sql
      sql = `${sql} limit ${start},${count};`
    }

    // do query
    let rows = null // eslint-disable-line
    if (sql) {
      try {
        rows = await this.getSql(sql, req)
      } catch (err) {
        console.warn('查询 REPT DB 失败！ \n\t', err)
        message = {
          code: -1,
          msg: '查询失败！',
          key: req.key
        }
        callback(message)
      }
      if (rows.length < 1 && pageIndex > 0 && total % pageSize === 0) {
        pageIndex = pageIndex - 1
        let reStart = pageSize * pageIndex
        let count = req.data.pageSize
        reSql = `${reSql} limit ${reStart},${count};`
        try {
          rows = await this.getSql(reSql, req)
        } catch (err) {
          console.warn('查询 REPT DB 失败！ \n\t', err)
          message = {
            code: -1,
            msg: '查询失败！',
            key: req.key
          }
          callback(message)
        }
      }
    }

    // answer client
    message = {
      code: 0,
      msg: 'OK',
      data: rows,
      total: total,
      pageIndex: pageIndex,
      key: req.key
    }

    if (req.data.name === 'TrackList' || req.data.name === 'TrackData') {
      this.dealTrackListData(message)
    } else if (/^[0-9]{1,13}card$/ig.test(req.data.name)) {
      this.dealCardData(message)
    } else if (/^[0-9]{1,13}point$/ig.test(req.data.name)) {
      this.dealCardPoint(message)
    } else if (req.data.name === 'updatePath') {
      message.data = this.dealUpdatePathData(message.data)
    } else if (req.data.name === 'updatePathRpt') {
      message.data.pathSql = this.dealUpdatePathData(message.data.pathSql)
    }
    callback(message)
  }

  dealData (item, msg, datas, name) {
    let beginTime = item.begin_time
    let endTime = item.last_time
    beginTime = new Date(beginTime).getTime()
    endTime = new Date(endTime).getTime()
    let speed = item.speed
    msg['speed'] = speed * 2 * 3.6
    let coordinate = item.begin_pt
    coordinate = coordinate.split(',')
    let x = Number(coordinate[0])
    let y = Number(coordinate[1])
    msg['x'] = Number(x.toFixed(2))
    msg['y'] = Number(y.toFixed(2))
    msg['cur_time'] = new Date(beginTime).format('yyyy-MM-dd hh:mm:ss')
    msg['end_time'] = new Date(endTime).format('yyyy-MM-dd hh:mm:ss')
    datas.push(msg)
  }

  dealTrackListData (message, callback) {
    let rows = message.data
    let datas = []
    let type = rows[0]
    let staffID = type && type.staff_id
    let vehicleID = type && type.vehicle_id
    let name = null
    if (staffID) {
      name = 'staff_id'
    } else if (vehicleID) {
      name = 'vehicle_id'
    }
    for (let i = 0, length = rows.length; i < length; i++) {
      let item = rows[i]
      let nextitem = rows[i + 1]
      let nextpoint = nextitem && nextitem.begin_pt
      if (!item.last_time) {
        if (nextitem) {
          item.last_time = nextitem.begin_time
        } else {
          item.last_time = new Date().format('yyyy-MM-dd hh:mm:ss')
        }
      }
      let beginTime = item.begin_time
      if (!beginTime) return
      let msg = {
        card_id: item.card_id,
        map_id: 5,
        speed: item.speed,
        landmark_id: item.landmark_id || 0,
        direction_mapper_id: item.direction_mapper_id || 0,
        landmark_dist: item.landmark_dist || 0,
        area_id: item.area_id
      }
      msg[name] = item[name]
      this.dealData(item, msg, datas, 'trackList', nextpoint)
    }
    if (datas.length > 0) message['data'] = datas
  }

  dealPathData (item, msg, datas, name) {
    let coordinate = item.begin_pt
    coordinate = coordinate.split(',')
    let cmsg = JSON.parse(JSON.stringify(msg))
    let x = Number(coordinate[0])
    let y = Number(coordinate[1])
    cmsg['x'] = Number(x.toFixed(2))
    cmsg['y'] = Number(y.toFixed(2))
    datas.push(cmsg)
  }

  dealUpdatePathData (rows) {
    // let rows = message.data
    let datas = []
    rows.forEach((item) => {
      let msg = {
        id: item.id,
        card_id: item.card_id,
        map_id: 5,
        speed: item.speed,
        last_time: item.last_time,
        landmark_id: item.landmark_id || 0,
        direction_mapper_id: item.direction_mapper_id || 0,
        landmark_dist: item.landmark_dist || 0,
        begin_time: item.begin_time || 0,
        end_time: item.end_time || 0,
        old_state: 1,  // 1表示历史z已经存在的数据
        reader_id: item.reader_id || 0
      }
      this.dealPathData(item, msg, datas, 'trackList')
    })
    if (datas.length > 0) return datas
  }

  dealCardData (message) {
    let rows = message.data
    let datas = []
    rows.forEach((item) => {
      let beginTime = item.begin_time
      if (!beginTime) return
      let msg = {
        card_id: item.card_id
      }
      this.dealData(item, msg, datas)
    })
    if (datas.length > 0) message['data'] = datas
  }

  dealCardPoint (message) {
    let rows = message.data
    let datas = []
    rows.forEach((item) => {
      let beginTime = item.begin_time
      if (!beginTime) return
      let msg = {
        card_id: item.card_id,
        staff_id: item.staff_id
      }
      this.dealData(item, msg, datas)
    })
    if (datas.length > 0) message['data'] = datas
  }
}
