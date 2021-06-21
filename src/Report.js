import mysql from './MysqlWraper.js'
import csv from 'fast-csv'
import PdfPrinter from 'pdfmake'
import Excel from 'ejsexcel'
import Logger from './Logger.js'

let pdfDefinition = require('./pdfDefinition.js')
let PdfPrinterDriver = require('./pdfDefintionDriver.js')
let fs = require('fs')
let path = require('path')
let config = require('./config/appconfig.js')

export default class Report {
  constructor (user, metaStore) {  // eslint-disable-line
    this.user = user
    this.metaStore = metaStore
    this.pdfDefinition = pdfDefinition
    this.pdfDefinitionDriver = PdfPrinterDriver
  }

  dispatch (socket, req, callback) {
    if (!req) {
      console.warn('Report: no req data.')
      return
    }

    switch (req.cmd) {
      case 'file':
        this.data = req.data
        this.sendFile(socket, req, callback)
        break
      default:
        console.warn(`未知的 REPT 请求：${req.cmd}`)
        break
    }
  }

  formatField (name, value, types, namesInShort, tablename) {
    let type = types[namesInShort.indexOf(name)]
    return this.metaStore.formatField(name, value, type, '', tablename)
  }

  async sendFile (socket, req, callback) {
    // console.log('REPT : \n ', req)
    let message = null  // return message

    let rows = null
    try {
      rows = await mysql.query(req.sql)
    } catch (err) {
      console.warn('查询 REPT DB 失败！ \n\t', err)
      message = {
        code: -1,
        msg: '查询失败！'
      }
      callback(message)

      return
    }

    let namesInShort = req.namesInShort
    let types = req.types
    for (let i = 0; i < rows.length; i++) {
      for (let name in rows[i]) {
        // console.log('the item of rows is ' + j + ', the content is ' + rows[i][j])
        let value = rows[i][name]
        rows[i][name] = namesInShort && this.formatField(name, value, types, namesInShort, req.name)
      }
    }

    let fieldLabels = req.labels

    let reptTitle = req.title  // report reptTitle
    let fileType = req.fileType  // csv, pdf
    let name = req.name
    let data = req.data ? JSON.parse(req.data) : []
    let time = req.time ? req.time : ''
    // let hash = crypto.createHash('md5')
    // let hashString = hash.digest('hex')
    let date = new Date()
    let fileName = this.user.name + '-' + req.name + '-' + date.format('yyyyMMddhhmmss')
    let fileFullName = `${fileName}.${fileType === 'printPDF' ? 'pdf' : fileType}`

    let fileRelativePath = `/datafiles/${fileType === 'printPDF' ? 'pdf' : fileType}`

    let fileURI = `${fileRelativePath}/${fileFullName}`
    let filePath = path.resolve(config.CLIENT_STATIC_DIR, `.${fileURI}`)

    let isCreateFileOK = false
    switch (fileType) {
      case 'csv':
        isCreateFileOK = this.createCVS(filePath, fieldLabels, rows, reptTitle)
        break
      case 'xlsx':
        isCreateFileOK = this.createExcel(filePath, fieldLabels, rows, reptTitle, name, data, time)
        break
      case 'pdf':
      case 'printPDF':
        // console.log('>>>>>>>>>>>' + namesInShort.length)
        let widthes = []
        widthes[0] = '*'
        for (let i = 1, len = namesInShort.length; i < len; i++) {
          widthes[i] = parseInt(100 / len) + '%'
        }
        if (name !== 'driver') {
          this.pdfDefinition.content[0].text = null
          this.pdfDefinition.content[1].text = null
          this.pdfDefinition.content[2].text = null
          this.pdfDefinition.content[3].table.body.splice(0, this.pdfDefinition.content[3].table.body.length)
          this.pdfDefinition.content[3].table.widths = widthes
          this.pdfDefinition.content[4].text = null
        } else {
          this.pdfDefinitionDriver.content[0].text = null
          // this.pdfDefinitionDriver.content[1].text = null
          this.pdfDefinitionDriver.content[1].text = null
          this.pdfDefinitionDriver.content[2].table.body.splice(0, this.pdfDefinitionDriver.content[2].table.body.length)
          this.pdfDefinitionDriver.content[3].text = null
        }
        let userName = req.userName
        let timeStample = date.format('yyyy-MM-dd hh:mm')
        let expr = null
        if (req.exprList.length !== 0) {
          for (let i = 0; i < req.exprList.length; i++) {
            if (i === 0) {
              expr = req.exprList[i].label + ' '
            } else {
              expr += req.exprList[i].logicLabel + ' ' + req.exprList[i].label + ' '
            }
          }
        } else {
          expr = '所有记录'
        }

        /*
        console.log('Ready to soar')
        console.log('Fuel tanks are filled: ' + this.pdfDefinition.content[0].text)
        console.log('Gotta clear view, sir ' + this.pdfDefinition.content[3].table.body[0])
        console.log('-----------------------------------')
        */
        isCreateFileOK = this.createPDF(reptTitle, filePath, fieldLabels, rows, userName, timeStample, expr)
        break
      default:
        console.warn('UNKNOWN file type.', fileType)
        break
    }

    if (isCreateFileOK) {
      message = {
        code: 0,
        msg: 'OK',
        data: {
          name: `${fileName}.${fileType}`,
          fileType: fileType,
          url: fileURI
          // rows: rows
        }
      }
      this.judgeFileExist(filePath, callback, message)
      if (['staff_extend', 'vehicle_extend'].includes(name)) {
        let detail = ''
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]
          for (let item in row) {
            if (['staff_id', 'vehicle_id', 'dept_id'].includes(item)) {
              const fieldIndex = namesInShort.findIndex((name, i) => {
                return name === item
              })
              const labelName = fieldLabels[fieldIndex]
              detail += `${labelName}:${row[item]};`
            }
          }
        }
        detail = `web Tool${reptTitle}业务导出.${name}-${detail}`
        detail = detail.slice(0, 1024) // 避免字节长度超出导致添加录入数据库失败
        Logger.log2db(socket, 6, detail)
      }
    } else {
      message = {
        code: -1,
        msg: '获取文件失败，请联系系统管理员。'
      }
      callback(message)
    }

    // callback(message)
  }

  judgeFileExist (filePath, callback, message) {
    fs.exists(filePath, function (exist) {
      callback(message)
    })
  }

  getExcelDatas (worktimeDept) {
    let keys = Array.from(worktimeDept.keys())
    let arr = []
    keys.forEach(key => {
      let msg = {}
      let rows = worktimeDept.get(key)
      msg['dept_id'] = this.metaStore.getNameByID('dept_id', key)
      msg['znum'] = rows.get(1) ? rows.get(1).num : 0
      msg['zworktime'] = rows.get(1) ? rows.get(1).worktime : 0
      msg['enum'] = rows.get(2) ? rows.get(2).num : 0
      msg['eworktime'] = rows.get(2) ? rows.get(2).worktime : 0
      msg['fnum'] = rows.get(3) ? rows.get(3).num : 0
      msg['fworktime'] = rows.get(3) ? rows.get(3).worktime : 0
      msg['anum'] = msg['znum'] + msg['enum'] + msg['fnum']
      msg['aworktime'] = (msg['zworktime'] + msg['eworktime'] + msg['fworktime']).toFixed(2)
      arr.push(msg)
    })
    return arr
  }

  createExcel (filePath, labels, rows, reptTitle, name, data, time) {
    if (name === 'worktime_dept_shift') {
      let worktimeDept = new Map()
      rows.forEach(row => {
        let deptID = row.dept_id
        if (!worktimeDept.get(deptID)) {
          let ret = new Map()
          worktimeDept.set(deptID, ret)
        }
        let deptrow = worktimeDept.get(deptID)
        let shiftID = row.shift_id
        let msg = {
          num: row.num,
          worktime: row.worktime
        }
        deptrow.set(shiftID, msg)
      })
      let resultArr = this.getExcelDatas(worktimeDept)
      resultArr = [[{'tablename': reptTitle}], resultArr]
      let exlBuf = fs.readFileSync('../resource/worktime_dept_shift.xlsx')
      try {
        Excel.renderExcel(exlBuf, resultArr).then((exlBuf2) => {
          fs.writeFileSync(filePath, exlBuf2)
        })
      } catch (err) {
        return false
      }
      return true
    } else if (name === 'efficiency_manage') {
      let resultArr = data
      for (let i = 0; i < resultArr.length; i++) {
        resultArr[i][0].sort(function (a, b) { return a.index - b.index })
      }
      let allLength = {
        'jBoot': data[0][0].length - 1,
        'cBoot': data[0][1].length - 1,
        'totalBoot': data[0][0].length + data[0][1].length,
        'jRugular': data[1][0].length - 1,
        'cRugular': data[1][1].length - 1,
        'totalRugular': data[1][0].length + data[1][1].length,
        'jWorktime': data[2][0].length - 1,
        'cWorktime': data[2][1].length - 1,
        'totalWorktime': data[2][0].length + data[2][1].length
      }
      resultArr = [[{'tablename': reptTitle, 'tabletime': time}], [allLength], resultArr]
      let exlBuf = fs.readFileSync('../resource/efficiency_manage.xlsx')
      try {
        Excel.renderExcel(exlBuf, resultArr).then((exlBuf2) => {
          fs.writeFileSync(filePath, exlBuf2)
        })
      } catch (err) {
        return false
      }
      return true
    }
  }

  createCVS (filePath, labels, rows, reptTitle) {
    let csvStream = null

    let writableStream = null
    try {
      writableStream = fs.createWriteStream(filePath)
      // 在 csv 文件头写入 utf-8 BOM, 解决 excel 打开乱码的问题
      // writableStream.write(new Buffer('\xEF\xBB\xBF', 'binary'))
      writableStream.write(Buffer.from('\xEF\xBB\xBF', 'binary'))

      writableStream.on('finish', () => {
        console.log('Write csv file DONE! ', filePath)
      })
    } catch (err) {
      console.warn(`生成 CSV 文件 ${filePath} 失败！\n\t${err}`)
      return false
    }

    csvStream = csv.format({headers: true, quoteColumns: true, quoteHeaders: true})
    // csvStream = csv.format({headers: true})
    csvStream.pipe(writableStream)
        // .on('end', process.exit)
    let arrTitle = new Array(reptTitle)
    csvStream.write(arrTitle)
    csvStream.write(labels)
    // csvStream.write(rows)
    for (let j = 0; j < rows.length; j++) {
      let row = rows[j]
      let rowInArray = []
      for (let item in row) {
        rowInArray.push(row[item])
      }
      csvStream.write(rowInArray)
    }
    csvStream.end()

    return true
  }

  createPDF (reptTitle, filePath, labels, rows, userName, timeStample, expr) {
    let fonts = {
      Roboto: {
        normal: './fonts/Microsoft-YaHei.ttf',
        bold: './fonts/Microsoft-YaHei-Bold.ttf'
      }
    }

    let PDF = new PdfPrinter(fonts)
    // console.log('Ready to soar')
    // console.log('Fuel tanks are filled: ' + pdfDefinition.content[0].text)
   // console.log('Gotta clear view, sir ' + pdfDefinition.content[1].table.body)
   // console.log('-----------------------------------')

    if (reptTitle === '司机排班') {
      this.pdfDefinitionDriver.content[0].text = '高河矿' + reptTitle + '报表'
      // this.pdfDefinitionDriver.content[1].text = '（制表时间：' + timeStample + '）'
      this.pdfDefinitionDriver.content[1].text = '制表时间：' + timeStample
      this.pdfDefinitionDriver.content[2].table.body.push(labels)
      // console.log('>>>>>>>>>>>>>>>>>' + labels)
      this.pdfDefinitionDriver.content[3].text = '制表人: ' + '\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020' + '审核人：'
    } else {
      this.pdfDefinition.content[0].text = '高河矿' + reptTitle + '报表'
      this.pdfDefinition.content[1].text = '（' + expr + '）'
      this.pdfDefinition.content[2].text = ' 制表时间：' + timeStample
      this.pdfDefinition.content[3].table.body.push(labels)
      this.pdfDefinition.content[4].text = '制表人: ' + '\u0020\u0020\u0020\u0020\u0020\u0020\u0020\u0020' + '审核人：'
    }

    /*
    console.log('Check out the view ' + pdfDefinition.content[0].text)
    console.log('I can go anywhere ' + pdfDefinition.content[1].table.body)
    console.log('-----------------------------------')
    */
    // console.log('Pushin\' away.')
    // console.log('md,wobubianle')
    for (let j = 0; j < rows.length; j++) {
      // pdfDefinition.content[1].table.body.push(rows[j])
      let row = rows[j]
      let rowData = []
      for (let item in row) {
       // console.log('the type of item is ' + typeof (row[item]))
        // console.log('the content of item is ' + row[item])
        let data = null
        if (row[item] === null || row[item] === '' || typeof (row[item]) === 'undefined') {
          data = ' '
        } else if (typeof (row[item]) !== 'string') {
          data = row[item].toString()
        } else {
          data = row[item]
        }
        // console.log('the type of data is ' + typeof (data))
        rowData.push(data)
      }
      if (reptTitle === '司机排班') {
        this.pdfDefinitionDriver.content[2].table.body.push(rowData)
        // console.log('<<<<<<<<<<<<<<<' + rowData)
      } else {
        this.pdfDefinition.content[3].table.body.push(rowData)
      }
    }
    // console.log(pdfDefinition.styles)
    /*
    console.log('after push: ')
    console.log(pdfDefinition.content[0].text)
    console.log(pdfDefinition.content[1].table.body)
    */
    // console.log('Data push done')
    try {
      if (reptTitle === '司机排班') {
        let pdfDoc = PDF.createPdfKitDocument(this.pdfDefinitionDriver)
        pdfDoc.pipe(fs.createWriteStream(filePath))
        pdfDoc.end()
        // console.log('Tesla suit ready!')
      } else {
        // console.log('Training...')
        let pdfDoc = PDF.createPdfKitDocument(this.pdfDefinition)
        // console.log('Training Complete.')
        // console.log('PDF Soldier: ' + pdfDoc)
        // console.log('-------------')
        // console.log('How \'bout some action?')
        pdfDoc.pipe(fs.createWriteStream(filePath))
        // console.log('For Mother Russia!')
        // console.log('-------------')
        pdfDoc.end()
        // console.log('Tesla suit ready!')
      }
    } catch (err) {
      console.log(err)
      console.warn(`生成 PDF 文件 ${filePath} 失败！\n\t${err}`)
      return false
    }
    return true
  }
}
