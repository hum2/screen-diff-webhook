const pptr = require("puppeteer")
const csv = require("csv")
const { createObjectCsvWriter } = require("csv-writer");
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const events = require("events")
const Promise = require("bluebird")
const resemble = require("resemblejs")
const imagemin = require('imagemin')
const imageminPngquant = require('imagemin-pngquant')
const logger = require("log4js").getLogger()
const join = Promise.join



// 定数 --------------------------
const CONCURRENCY_CNT = 20
logger.level = 'info'
// ------------------------------

let eventEmitter = new events.EventEmitter();
eventEmitter.setMaxListeners(0);

const getUaOptions = async (device) => {
  if (device == "sp") {
    width = 400
    ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1";
  } else {
    width = 1024
    ua = "Mozilla/5.0"
  }

  return await {
    viewport: {
      width: width,
      height: 600,
    },
    userAgent: ua,
  }
}

const saveScreenShot = async (url, device, filename) => {
  const browser = await pptr.launch({})
  const page = await browser.newPage()
  try {
    await page.emulate(await getUaOptions(device))
    await page.goto(url)
    // スクロールしないとサイドカラムがでないため、一度スクロールをする
    await page.evaluate((scrollTo) => {
      return Promise.resolve(window.scrollTo(0, scrollTo))
    }, 10)

    await page.screenshot({ path: filename, fullPage: true })
    title = await page.title()
    logger.debug(`\tSaved screenshot: ${filename}(${title})`)

    await browser.close()
    return title
  } catch (e) {
    await browser.close()
    logger.debug(`\tRetry ${url}`)
    return await saveScreenShot(url, device, filename)
  }
}

const setHashPath = async (dic) => {
  key = await crypto.createHash("md5").update(dic["path"], "binary").digest("hex")
  dic["image_dir"] = `images/${key}/`

  return dic
}

const makeImageDir = async (dic) => {
  // Make directory
  if (!fs.existsSync(dic["image_dir"])) {
    fs.mkdirSync(dic["image_dir"])
  }

  return dic
}

const imageminPng = async (dic, filename) => {
  logger.debug(`\tImage minify: ${dic["image_dir"]}${filename}`)
  await imagemin([`${dic["image_dir"]}${filename}`], dic["image_dir"], {
    plugins: [imageminPngquant({ quality: '80' })]
  })

  return dic
}

const saveImage = async (dic, device, key) => {
  const filename = `${dic["image_dir"]}${device}_${key}.png`
  logger.debug(`\tSave image: ${filename}`)
  if (!fs.existsSync(filename)) {
    dic["title"] = await saveScreenShot(dic[`${key}url`], device, filename)
  }

  return dic
}

const saveDiffImage = async (dic, device) => {
  const filename = `${dic["image_dir"]}${device}_diff.png`
  logger.debug(`\tSave diff image: ${filename}`);
  await resemble(`${dic["image_dir"]}${device}_old.png`)
    .compareTo(`${dic["image_dir"]}${device}_new.png`)
    .ignoreColors()
    .outputSettings({
      transparency: 0.3,
      errorType: "movement"
    })
    .onComplete(async (data) => {
      dic[`${device}_image`] = filename
      fs.writeFileSync(dic[`${device}_image`], data.getBuffer())
      dic[`${device}_score`] = data.misMatchPercentage
    })

  return dic
}

const appendCsv = async (dic, filename) => {
  csvWriter = createObjectCsvWriter({
    path: filename,
    header: ["category", "title", "oldurl", "newurl", "sp_score", "sp_image", "pc_score", "pc_image", "path"],
    encoding: "utf8",
    append: true
  })
  csvWriter.writeRecords([dic])
    .then(() => {
    })
}

const main = async () => {
  logger.info("Start")
  fs.readFile(`${path.resolve(__dirname, "..")}/base.csv`, async (err, data) => {
    // オプションに{columns:true}をつけると、1行目をプロパティ名にしたオブジェクトの配列が返る
    csv.parse(data, { columns: true }, async (err, output) => {
      const p = Promise.map(output, n => n)

      logger.info("init...")
      await p.map(async (n) => await setHashPath(n))
        .map(async (n) => await makeImageDir(n))

      logger.info("Save Screenshot...")
      await p.map(async (n) => await saveImage(n, "sp", "old"), { concurrency: CONCURRENCY_CNT })
        .map(async (n) => await saveImage(n, "sp", "new"), { concurrency: CONCURRENCY_CNT })
      await p.map(async (n) => await saveImage(n, "pc", "old"), { concurrency: CONCURRENCY_CNT })
        .map(async (n) => await saveImage(n, "pc", "new"), { concurrency: CONCURRENCY_CNT })

      logger.info("Save diff images...")
      await p.map(async (n) => await saveDiffImage(n, "sp"), { concurrency: CONCURRENCY_CNT })
        .map(async (n) => await saveDiffImage(n, "pc"), { concurrency: CONCURRENCY_CNT })

      logger.info("Compress images...")
      p.map(async (n) => await imageminPng(n, '*_diff.png'))
      logger.info("Append CSV...")
      p.map(async (n) => await appendCsv(n, 'hoge.csv'))

      logger.info("Finish")
    })
  })
}

main()
