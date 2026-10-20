/**
 * 京东比价 + 最低价监控 (还原原版表格 + 嵌入一键监控按钮)
 */

const CK_KEY = "manmanbuy_val";
const STORE_KEY = "JD_LOWEST_PRICE_RECORDS";

(async () => {
  // 1. 定时巡检破底价任务 (Cron)
  if (typeof $request === "undefined") {
    await runCronTask();
    $done();
    return;
  }

  const url = $request.url;

  // 2. 抓取慢慢买完整 CK
  if (url.includes("/baoliao/center/menu")) {
    if ($request.body) {
      $persistentStore.write($request.body, CK_KEY);
      $notification.post("京东比价助手", "获取ck成功🎉", "已成功保存慢慢买完整凭据");
    }
    $done({});
    return;
  }

  // 3. 点击按钮交互（添加 / 取消监控）
  if (url.includes("jd_monitor_toggle")) {
    handleToggleAction(url);
    return;
  }

  // 4. 详情页渲染：渲染原版表格 + 注入监控按钮
  if (url.includes("/product/graphext/")) {
    await handleDetailPage(url);
    return;
  }

  $done({});
})();

// ===================== 详情页处理 & 表格渲染 =====================
async function handleDetailPage(url) {
  const responseBody = $response?.body || "";
  try {
    const match = url.match(/product\/graphext\/(\d+)\.html/);
    if (!match) throw new Error("URL匹配失败");
    const skuId = match[1];

    // 获取慢慢买比价数据
    const { list, curPrice } = await getPriceDetail(skuId);

    // 查询当前商品是否在监控列表
    const records = JSON.parse($persistentStore.read(STORE_KEY) || "{}");
    const isMonitored = !!records[skuId];
    const recordLowest = records[skuId]?.lowest || curPrice;

    // 生成原版表格 HTML（并附带监控按钮）
    const html = Price_HTML(list, skuId, curPrice, isMonitored, recordLowest);

    // 替换并注入页面
    const body = responseBody.includes("<body>")
      ? responseBody.replace("<body>", `<body>${html}`)
      : responseBody.replace(/<body[^>]*>/i, (m) => `${m}\n${html}`);

    $done({ body });
  } catch (err) {
    console.log("比价渲染失败: " + err.message);
    const errHtml = `<div style="max-width:90%;margin:15px auto;padding:12px;background:#fff2f0;color:#d32f2f;border:1px solid #ffccc7;border-radius:10px;font-size:13px;"><strong>慢慢买提示：${err.message}</strong></div>`;
    const body = responseBody.replace("<body>", `<body>${errHtml}`);
    $done({ body });
  }
}

// 原版比价表格生成函数（加入了一键监控按钮）
function Price_HTML(priceList, skuId, curPrice, isMonitored, recordLowest) {
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split("T")[0];

  const rows = priceList
    .map((item) => {
      let { Name: name, Date: date, Price: price = "", Difference: diff = "" } = item;
      if (name === "当前到手价") {
        date = today;
        diff = "仅供参考";
      } else {
        date = date || "-";
      }
      let diffClass = "";
      if (diff.startsWith("↑")) diffClass = "up";
      else if (diff.startsWith("↓")) diffClass = "down";
      return `<tr><td>${name}</td><td>${date}</td><td>${price}</td><td class="price-diff ${diffClass}">${diff}</td></tr>`;
    })
    .join("");

  return `
    <div class="price-container">
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 4px 10px;">
        <div>
          <span style="font-size: 15px; color: #e61a23; font-weight: bold;">📊 历史比价</span>
          <span style="font-size: 11px; color: #888; margin-left: 6px;">${isMonitored ? `(当前记录底价: ¥${recordLowest})` : ""}</span>
        </div>
        <button id="jd-btn" onclick="toggle('${skuId}', ${curPrice})" style="background: ${isMonitored ? "#52c41a" : "#e61a23"}; color: #fff; border: none; padding: 6px 12px; border-radius: 14px; font-size: 12px; font-weight: bold; cursor: pointer;">
          ${isMonitored ? "✓ 监控中 (点击取消)" : "➕ 监控此商品最低价"}
        </button>
      </div>
      <table class="price-table">
        <thead><tr><th>类型</th><th>日期</th><th>价格</th><th>差价</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <style>
      body, table { font-family: "PingFang SC","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif; }
      .price-container { max-width: 800px; margin: 10px auto; padding: 12px; font-size: 13px; font-weight: bold; background: #FFF9F9; color: #333; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
      .price-table { width: 100%; border-collapse: separate; border-spacing: 0; border-radius: 8px; overflow: hidden; }
      .price-table th { background: #e61a23; color: #fff; padding: 10px; text-align: left; font-weight: bold; }
      .price-table td { padding: 10px; border-bottom: 1px solid #EEE; font-weight: bold; }
      .price-diff.up { color: #C91623; font-weight: bold; }
      .price-diff.down { color: #00aa00; font-weight: bold; }
    </style>
    <script>
      function toggle(s, p) {
        const btn = document.getElementById('jd-btn');
        btn.innerText = '提交中...';
        fetch('https://in.m.jd.com/jd_monitor_toggle?sku=' + s + '&price=' + p)
          .then(r => r.json())
          .then(d => {
            if (d.action === 'added') {
              btn.style.background = '#52c41a';
              btn.innerText = '✓ 监控中 (点击取消)';
            } else {
              btn.style.background = '#e61a23';
              btn.innerText = '➕ 监控此商品最低价';
            }
          })
          .catch(() => alert('操作超时，请重试'));
      }
    </script>
  `;
}

// ===================== 按钮交互处理 =====================
function handleToggleAction(url) {
  const sku = url.match(/sku=(\d+)/)?.[1];
  const price = parseFloat(url.match(/price=([0-9.]+)/)?.[1] || "0");

  let records = JSON.parse($persistentStore.read(STORE_KEY) || "{}");
  let action = "";

  if (records[sku]) {
    delete records[sku];
    action = "removed";
  } else {
    records[sku] = { lowest: price, time: Date.now() };
    action = "added";
    notify("📌 已加入降价监控", `商品 ID: ${sku}`, `基准底价设为: ¥${price}，创新低时将通知`, sku);
  }

  $persistentStore.write(JSON.stringify(records), STORE_KEY);

  $done({
    response: {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: 200, action, lowest: records[sku]?.lowest }),
    },
  });
}

// ===================== 定时巡检任务 (Cron) =====================
async function runCronTask() {
  const records = JSON.parse($persistentStore.read(STORE_KEY) || "{}");
  const skuList = Object.keys(records);

  if (skuList.length === 0) {
    console.log("当前无监控商品。在商品详情页比价表格上方点击按钮即可添加。");
    return;
  }

  console.log(`[定时巡检] 开始检查 ${skuList.length} 件监控商品...`);

  for (const skuId of skuList) {
    try {
      const { curPrice } = await getPriceDetail(skuId);
      const item = records[skuId];

      if (curPrice < item.lowest) {
        const drop = (item.lowest - curPrice).toFixed(2);
        const oldLowest = item.lowest;
        item.lowest = curPrice;

        notify(
          `🎉 京东破底价: 商品 ${skuId}`,
          `现价 ¥${curPrice}（降幅 -¥${drop}）`,
          `原低价 ¥${oldLowest} ➡️ 最新底价 ¥${curPrice}。点击直达购买`,
          skuId
        );
        console.log(`[创新低] ${skuId}: ¥${oldLowest} -> ¥${curPrice}`);
      } else {
        console.log(`[未创新低] ${skuId}: 现价 ¥${curPrice}, 最低 ¥${item.lowest}`);
      }

      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.log(`[巡检异常] ${skuId}: ${err.message}`);
    }
  }

  $persistentStore.write(JSON.stringify(records), STORE_KEY);
}

// ===================== 慢慢买数据请求链路 =====================
async function getPriceDetail(skuId) {
  const jdUrl = `https://item.jd.com/${skuId}.html`;

  // 1. 获取 stteId (V2)
  let link = jdUrl, stteId = null;
  try {
    const parse = await mmbRequest(
      { methodName: "commonMethod", searchKey: jdUrl, scene: "TrendHomeUnInput", c_ctrl: "Tabs" },
      "https://apapia-common.manmanbuy.com/SiteCommand/parse"
    );
    if (parse?.ok === 1 && parse?.result?.stteId) {
      link = parse.result.link || jdUrl;
      stteId = parse.result.stteId;
    }
  } catch (e) {}

  // 2. 获取 spbh
  const base = "https://apapia-history-weblogic.manmanbuy.com/basic";
  const basicUrl = stteId ? `${base}/v2/getItemBasicInfo` : `${base}/getItemBasicInfo`;
  const basic = await mmbRequest(
    { methodName: "getHistoryInfoJava", searchKey: link, c_ctrl: "Tabs", ...(stteId && { stteId }) },
    basicUrl
  );
  if (basic?.ok !== 1 || !basic?.result?.spbh) throw new Error(basic?.msg || "获取商品SPBH失败");

  // 3. 获取价格趋势
  const trend = await mmbRequest(
    {
      methodName: "getHistoryTrend2021",
      url: basic.result.url,
      spbh: basic.result.spbh,
      c_ctrl: "TrendDetailScene",
      callPos: "trend_detail",
      currentScene: "TrendDetailRecent",
      eventName: "查询商品历史价格",
      pagecFrom: "TrendHomeUnInput",
      chartStyleTest: "testA",
    },
    "https://apapia-history-weblogic.manmanbuy.com/history/v2/getHistoryTrend"
  );
  if (trend?.ok !== 1 || !trend?.result?.trend) throw new Error(trend?.msg || "获取价格趋势失败");

  // 4. 价格备注
  const remark = await mmbRequest(
    { methodName: "priceRemarkJava", jiagequshiyh: trend.result.trend, c_ctrl: "TrendDetailScene" },
    "https://apapia-history-weblogic.manmanbuy.com/history/priceRemark"
  );
  if (remark?.ok !== 1) throw new Error(remark?.msg || "获取价格明细失败");

  const ListPriceDetail = remark.remark?.ListPriceDetail || [];
  const exclude = new Set(["当前到手价", "历史最低价", "618价格", "双11价格", "30天最低价", "60天最低价", "180天最低价"]);
  const list = ListPriceDetail.filter((i) => exclude.has(i.Name));

  const curItem = ListPriceDetail.find((i) => i.Name === "当前到手价" || i.ShowName?.includes("当前")) || list[0];
  const curPrice = parseFloat(curItem?.Price || "0");

  return { list, curPrice };
}

// 封装发送请求
async function mmbRequest(params, url) {
  const rawBody = $persistentStore.read(CK_KEY);
  if (!rawBody) throw new Error("请先打开【慢慢买】APP，点击【我的】获取CK");

  const baseParams = {};
  rawBody.split("&").forEach((pair) => {
    const [k, v] = pair.split("=");
    if (k) baseParams[decodeURIComponent(k)] = decodeURIComponent(v || "");
  });
  ["c_ctrl", "methodName", "level", "t", "token"].forEach((k) => delete baseParams[k]);

  const requestBody = { ...baseParams, ...params, t: Date.now().toString() };
  const SECRET_KEY = "3E41D1331F5DDAFCD0A38FE2D52FF66F";

  const customStr = Object.keys(requestBody)
    .filter((k) => requestBody[k] !== "" && k.toLowerCase() !== "token")
    .sort()
    .map((k) => `${k.toUpperCase()}${String(requestBody[k]).toUpperCase()}`)
    .join("");

  requestBody.token = md5(encodeURIComponent(SECRET_KEY + customStr + SECRET_KEY)).toUpperCase();

  const body = Object.keys(requestBody)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(requestBody[k])}`)
    .join("&");

  return new Promise((resolve, reject) => {
    $httpClient.post(
      {
        url,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6_1 like Mac OS X) AppleWebKit/605.1.15",
        },
        body,
      },
      (err, resp, data) => {
        if (err) return reject(new Error(err));
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      }
    );
  });
}

function notify(title, subtitle, body, skuId) {
  const jumpUrl = `openapp.jdmobile://virtual?params={"category":"jump","des":"productDetail","skuId":"${skuId}"}`;
  $notification.post(title, subtitle, body, { openUrl: jumpUrl });
}

// 极简 MD5
function md5(string) {
  function R(A, B) { return (A << B) | (A >>> (32 - B)); }
  function C(q, a, b, x, s, t) { return ((q = q + a + x + t) << s | q >>> (32 - s)) + b; }
  function F(a, b, c, d, x, s, t) { return C((b & c) | (~b & d), a, b, x, s, t); }
  function G(a, b, c, d, x, s, t) { return C((b & d) | (c & ~d), a, b, x, s, t); }
  function H(a, b, c, d, x, s, t) { return C(b ^ c ^ d, a, b, x, s, t); }
  function I(a, b, c, d, x, s, t) { return C(c ^ (b | ~d), a, b, x, s, t); }
  let x = Array(string.length);
  for (let i = 0; i < string.length; i++) x[i >> 2] |= (string.charCodeAt(i) & 255) << ((i % 4) * 8);
  let l = string.length * 8;
  x[l >> 5] |= 128 << (l % 32);
  x[(((l + 64) >>> 9) << 4) + 14] = l;
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    let [A, B, C, D] = [a, b, c, d];
    a = F(a, b, c, d, x[i + 0], 7, -680876936); d = F(d, a, b, c, x[i + 1], 12, -389564586);
    c = F(c, d, a, b, x[i + 2], 17, 606105819); b = F(b, c, d, a, x[i + 3], 22, -1044525330);
    a = F(a, b, c, d, x[i + 4], 7, -176418897); d = F(d, a, b, c, x[i + 5], 12, 1200080426);
    c = F(c, d, a, b, x[i + 6], 17, -1473231341); b = F(b, c, d, a, x[i + 7], 22, -45705983);
    a = F(a, b, c, d, x[i + 8], 7, 1770035416); d = F(d, a, b, c, x[i + 9], 12, -1958414417);
    c = F(c, d, a, b, x[i + 10], 17, -42063); b = F(b, c, d, a, x[i + 11], 22, -1990404162);
    a = F(a, b, c, d, x[i + 12], 7, 1804603682); d = F(d, a, b, c, x[i + 13], 12, -40341101);
    c = F(c, d, a, b, x[i + 14], 17, -1502000000); b = F(b, c, d, a, x[i + 15], 22, 1236535329);
    a = G(a, b, c, d, x[i + 1], 5, -165796510); d = G(d, a, b, c, x[i + 6], 9, -1069501632);
    c = G(c, d, a, b, x[i + 11], 14, 643717713); b = G(b, c, d, a, x[i + 0], 20, -373897302);
    a = G(a, b, c, d, x[i + 5], 5, -701558691); d = G(d, a, b, c, x[i + 10], 9, 38016083);
    c = G(c, d, a, b, x[i + 15], 14, -660478335); b = G(b, c, d, a, x[i + 4], 20, -405537848);
    a = G(a, b, c, d, x[i + 9], 5, 568446438); d = G(d, a, b, c, x[i + 14], 9, -1019803690);
    c = G(c, d, a, b, x[i + 3], 14, -187363961); b = G(b, c, d, a, x[i + 8], 20, 1163531501);
    a = G(a, b, c, d, x[i + 13], 5, -1444681467); d = G(d, a, b, c, x[i + 2], 9, -51403784);
    c = G(c, d, a, b, x[i + 7], 14, 1735328473); b = G(b, c, d, a, x[i + 12], 20, -1926607734);
    a = H(a, b, c, d, x[i + 5], 4, -378558); d = H(d, a, b, c, x[i + 8], 11, -2022574463);
    c = H(c, d, a, b, x[i + 11], 16, 1839030562); b = H(b, c, d, a, x[i + 14], 23, -35309556);
    a = H(a, b, c, d, x[i + 1], 4, -1530992060); d = H(d, a, b, c, x[i + 4], 11, 1272893353);
    c = H(c, d, a, b, x[i + 7], 16, -155497632); b = H(b, c, d, a, x[i + 10], 23, -1094730640);
    a = H(a, b, c, d, x[i + 13], 4, 681279174); d = H(d, a, b, c, x[i + 0], 11, -358537222);
    c = H(c, d, a, b, x[i + 3], 16, -722521979); b = H(b, c, d, a, x[i + 6], 23, 76029189);
    a = H(a, b, c, d, x[i + 9], 4, -640364487); d = H(d, a, b, c, x[i + 12], 11, -421815835);
    c = H(c, d, a, b, x[i + 15], 16, 530742520); b = H(b, c, d, a, x[i + 2], 23, -995338651);
    a = I(a, b, c, d, x[i + 0], 6, -198630844); d = I(d, a, b, c, x[i + 7], 10, 1126891415);
    c = I(c, d, a, b, x[i + 14], 15, -1416354905); b = I(d, a, b, c, x[i + 5], 21, -57434055);
    a = I(a, b, c, d, x[i + 12], 6, 1700485571); d = I(d, a, b, c, x[i + 3], 10, -1894986606);
    c = I(c, d, a, b, x[i + 10], 15, -1051523); b = I(b, c, d, a, x[i + 1], 21, -2054922799);
    a = I(a, b, c, d, x[i + 8], 6, 1873313359); d = I(d, a, b, c, x[i + 15], 10, -30611744);
    c = I(c, d, a, b, x[i + 6], 15, -1560198380); b = I(b, c, d, a, x[i + 13], 21, 1309151649);
    a = I(a, b, c, d, x[i + 4], 6, -145523070); d = I(d, a, b, c, x[i + 11], 10, -1120210379);
    c = I(c, d, a, b, x[i + 2], 15, 718787259); b = I(b, c, d, a, x[i + 9], 21, -343485551);
    a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
  }
  return [a, b, c, d].map((n) => (n < 0 ? n + 4294967296 : n).toString(16).padStart(8, "0").match(/../g).reverse().join("")).join("");
}
