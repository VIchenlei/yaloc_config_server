import Meta from './Meta.js'
import numberTurnText from './number_turn_text.js'
/*
meta data structure is :
meta = {
 name: map{
       (key, {field: value, ...}),
       (...)
     }
 ...
}

so, the access path is : meta(name -> key -> field)
*/

// 以 '_id' 结尾的通配符
let endWithID = /^(\w*)_id$/i

export default class MetaStore {
  constructor () {
    this.defs = null // meta data definition
    this.data = {} // meta data store
    this.meta = new Meta()
    this.registerGlobalEventHandlers()
  }

  async registerGlobalEventHandlers () {
    let self = this
    self.defs = self.meta.sendMetaDefinition(null)
    let res = await self.meta.sendAllMetaDataForMetaStoreOnServer()

    for (let i = 0; i < res.length; i++) {
      if (res[i] && res[i].code === 0) {
        self.saveMetaData(res[i].data.name, res[i].data.rows)
      } else {
        console.warn(`获取 META ${res.data.name} 失败。`)
      }
    }
  }

  saveMetaData (name, rows) {
        // save to a map
    let tmp = new Map() // temp map to save the rows

    if (rows) {
      let def = this.defs[name]
      let keyName = def.fields.names[def.keyIndex]

      for (let item of rows) {
                // save to data
        if (name === 'driver_arrange') {
          if (new Date(item.driver_date).format('yyyy-MM-dd') === new Date().format('yyyy-MM-dd')) {
            let keyValue = item[keyName]
            tmp.set(keyValue, item)
          }
        } else {
          let keyValue = item[keyName]
          tmp.set(keyValue, item)
        }
      }
    }

    this.data[name] = tmp
  }
    // operation

    /**
     * [description]
     * @param  {[type]} name  [the resultset name]
     * @param  {[type]} id    [the key's value]
     * @param  {[type]} field [the field you wanna get]
     * @return {[type]}       [the field's value]
     */
  getField (name, id, field) {
    let ret = null
    if (name && id && field) {
      let rows = this.data[name]
      if (rows) {
        let row = rows.get(id)
        if (row) {
          ret = row[field]
        }
      }
    }
    return ret
  }

  formatRecord (def, row, rule) { // rule: SHORT-DATE or not, etc.
    if (!def || !row) {
      return row
    }

    let ret = {}
    for (let i = 0; i < def.fields.names.length; i++) {
      let name = def.fields.names[i]

      if (i === def.keyIndex) { // key 不做转换
        ret[name] = row[name]
        continue
      }

      let type = def.fields.types[i]
      let value = row[name]
      value = this.formatField(name, value, type, rule)

      ret[name] = value
    }
    return ret
  }

  formatField (name, value, type, rule, tablename) {
    if (value === null || value === undefined || value === '') {
      return ''
    }

    if (numberTurnText.hasOwnProperty(tablename)) {
      let hasTurnName = numberTurnText[tablename][name]
      if (hasTurnName) return hasTurnName[value]
    }
        // debugger  // eslint-disable-line
    let ret = value
    switch (type) {
      case 'NUMBER':
        ret = Number(value)
        break
      case 'SELECT':
        if (endWithID.exec(name)) {
          ret = this.getNameByID(name, value)
        }
        break
      case 'DATETIME':
        let sformater = rule && rule === 'SHORT-DATE' ? 'MM-dd hh:mm' : 'yyyy-MM-dd hh:mm:ss'
        ret = new Date(value).format(sformater)
        break
      default:
                // console.warn('未知的字段类型：', type)
        break
    }

    return ret
  }

    /**
     * 从 'xxx_id' 字段获取所对应的名称(name字段)
     * 要求：
     * 1. 所有 id 字段必须为 xxx_id 的形式，其对应表的名字为 dat_xxx，如 map_id, 对应表为 dat_map
     * 2. 有一个 name 字段，如 dat_map 中，有一个 name 字段，是对 map_id 的名称
     * 则： getNameByID('map_id', 5) 可以获得 map_id = 5 的地图的名称
     *
     * @method getNameByID
     *
     * @param  {[type]}    idFieldName  [description]
     * @param  {[type]}    idFieldValue [description]
     *
     * @return {[type]}                   [description]
     */
  getNameByID (idFieldName, idFieldValue) {
    let fieldName = 'name'
    if (idFieldName === 'device_type_id' || idFieldName === 'card_type_id') {
      fieldName = 'detail' // device 和 card 的描述字段是 'detail'
    }

    return this.getFieldByID(idFieldName, idFieldValue, fieldName)
  }

  getFieldByID (idName, idValue, fieldName) {
    let ret = idValue
    let r = endWithID.exec(idName)
    if (r) {
      let ds = this.data[r[1]]
      if (ds) {
        let row = ds.get(parseInt(idValue, 10))
        if (row) {
          let label = row[fieldName]
          if (label) {
            ret = label
          }
        }
      }
    }

    return ret
  }

    /**
     * [getList 根据 xx_id 字段，获取对应的列表
     * @param  {[type]} idName [description]
     * @return {[type]}        [list: [{row}, {row}, ...]]
     */
  getList (idName) {
    let list = []
    let r = endWithID.exec(idName)
    if (r) {
      let dsName = r[1]
      let ds = this.data[dsName]
      if (ds) {
        list = ds.values()
      }
    }

    return list
  }
}
