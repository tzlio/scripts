/*
脚本引用 https://raw.githubusercontent.com/githubdulong/Script/master/jd_price.js
2025-05-15 05:41:24 验证可用版基底
已彻底解决：
1. 抓取CK完全恢复原版直抓逻辑，确保必弹窗并存入
2. parsePrice 正则清洗剔除 ¥ 符号，彻底根治底价 NaN
3. 全量继承 4.9.61 真实请求体参数（包含 c_app 等），彻底解决 token 校验失败
4. 点击本地即时 Mock，防止操作超时
*/
const path1 = '/product/graphext/';
const path2 = '/baoliao/center/menu';
const path_toggle = 'jd_monitor_toggle';
const manmanbuy_key = 'manmanbuy_val';
const store_records_key = 'JD_LOWEST_PRICE_RECORDS';

const $ = new Env("京东比价");
const isCron = typeof $request === "undefined";
const url = isCron ? "" : ($request.url || "");

// 默认首选版本
$.version = $.getdata('mmb_v') || 'V1';

// 场景 1: 定时巡检任务 (Cron)
if (isCron) {
    cronTask().then(() => $.done()).catch(e => { $.logErr(e); $.done(); });
}

// 场景 2: 抓取 CK (100%还原你原版有效写法，直接存入并弹窗，绝不阻断)
if (url.includes(path2)) {
    const reqbody = $request?.body;
    if (reqbody) {
        $.setdata(reqbody, manmanbuy_key);
        $.msg($.name, '获取ck成功🎉', reqbody);
    }
    $done();
}

// 场景 3: 按钮点击响应（本地即刻 Mock，杜绝超时）
if (url.includes(path_toggle)) {
    handleToggle(url);
}

// 场景 4: 详情页注入红白比价表格与按钮
if (url.includes(path1)) {
    const responseBody = $response?.body;
    main()
        .then(res => $done(res || { body: responseBody }))
        .catch(err => {
            const html = `<div style="max-width: 90%;margin: 20px auto;padding: 16px;background: #ffffff;color: #d32f2f;border: 2px solid #f44336;border-radius: 12px;font-size: 15px;text-align:left;box-shadow: 0 2px 6px rgba(0,0,0,0.06);">
                <strong>慢慢买比价失败：</strong><br>${err.message}<br><br>
                <span style="font-size:12px;color:#666;">💡 提示：若提示凭证失效，请打开【慢慢买】APP 重新点击一次【我的】刷新凭证。</span>
            </div>`;
            $done({
                body: responseBody.replace("<body>", `<body>${html}`)
            });
        });
}

// ===================== 详情页主逻辑 (双轨容灾) =====================
async function main() {
    intCryptoJS();

    const match = url.match(/product\/graphext\/(\d+)\.html/);
    if (!match) throw new Error("京东URL匹配失败");
    const skuId = match[1];

    const JD_Url = `https://item.jd.com/${skuId}.html`;
    const responseBody = $response?.body;

    // 双轨重试机制：避免特定商品在单版本下偶发 token 校验失败
    const ListPriceDetail = await fetchPriceDetailWithRetry(JD_Url);

    const exclude = new Set(['当前到手价', '历史最低价', '618价格', '双11价格', '30天最低价', '60天最低价', '180天最低价']);
    const list = ListPriceDetail.filter(i => exclude.has(i.Name));

    // 安全清洗当前价格，剥离 ¥ / ￥ / 逗号，彻底杜绝 NaN
    let curItem = ListPriceDetail.find(i => (i.Name === '当前到手价' || i.Name?.includes('当前') || i.ShowName?.includes('当前')) && i.Price);
    if (!curItem) curItem = list.find(i => i.Price) || ListPriceDetail[0] || {};
    const curPrice = parsePrice(curItem.Price || curItem.price);

    // 读取本地监控状态与历史记录底价
    const records = $.getjson(store_records_key) || {};
    const isMonitored = !!records[skuId];
    const savedLowest = parsePrice(records[skuId]?.lowest);
    // 确保显示底价绝不为 NaN
    const recordLowest = savedLowest > 0 ? savedLowest : (curPrice > 0 ? curPrice : '待获取');

    const html = Price_HTML(list, skuId, curPrice, isMonitored, recordLowest);
    const body = responseBody.replace("<body>", `<body>${html}`);
    return { body };
}

// V1/V2 自动重试容灾查询器
async function fetchPriceDetailWithRetry(JD_Url) {
    let primary = $.version || "V1";
    let secondary = primary === "V1" ? "V2" : "V1";

    try {
        return await queryByVersion(JD_Url, primary);
    } catch (err1) {
        $.log(`[${primary}] 查询异常: ${err1.message || err1}，自动切换至 [${secondary}] 重试...`);
        try {
            return await queryByVersion(JD_Url, secondary);
        } catch (err2) {
            throw new Error(err1.message || err2.message || "比价数据获取失败");
        }
    }
}

async function queryByVersion(JD_Url, ver) {
    let link = JD_Url, stteId;
    if (ver === "V2") {
        const parse = checkRes(await get_stteId(JD_Url), '获取stteId [V2]');
        link = parse?.result?.link || JD_Url;
        stteId = parse?.result?.stteId;
    }
    const basic = checkRes(await get_spbh(link, stteId, ver), `获取spbh [${ver}]`);
    if (!basic?.result?.url || !basic?.result?.spbh) throw new Error("商品未收录");

    const jiagequshi = checkRes(await get_jiagequshi(basic.result.url, basic.result.spbh), '获取价格走势');
    if (!jiagequshi?.result?.trend) throw new Error("无走势数据");

    const trend = checkRes(await get_priceRemark(jiagequshi.result.trend), '获取价格明细');
    return trend?.remark?.ListPriceDetail || [];
}

function checkRes(res, desc = '') {
    if (!res || res.ok !== 1) {
        $.log(`慢慢买异常 [${desc}]：` + $.toStr(res));
        throw new Error(res?.msg || `${desc}失败`);
    }
    return res;
}

// 纯数字价格安全清洗器（去除 ¥、￥、逗号，确保绝不返回 NaN）
function parsePrice(val) {
    if (typeof val === 'number') return isNaN(val) ? 0 : val;
    if (!val) return 0;
    const clean = String(val).replace(/[^\d.]/g, '');
    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
}

// 比价 HTML
function Price_HTML(priceList, skuId, curPrice, isMonitored, recordLowest) {
    const rows = priceList.map(item => {
        let { Name: name, Date: date, Price: price = '', Difference: diff = '' } = item;
        if (name === '当前到手价') {
            date = $.time('yyyy-MM-dd');
            diff = '仅供参考';
        } else {
            date = date || '-';
        }
        let diffClass = '';
        if (diff.startsWith('↑')) diffClass = 'up';
        else if (diff.startsWith('↓')) diffClass = 'down';
        return `<tr><td>${name}</td><td>${date}</td><td>${price}</td><td class="price-diff ${diffClass}">${diff}</td></tr>`;
    }).join('');

    return `
    <div class="price-container">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:2px 4px 10px;">
            <div>
                <span style="font-size:15px;color:#e61a23;font-weight:bold;">📊 历史比价</span>
                <span style="font-size:11px;color:#888;margin-left:6px;">${isMonitored ? `(记录底价: ¥${recordLowest})` : ''}</span>
            </div>
            <button id="jd-btn" onclick="toggle('${skuId}', ${curPrice})" style="background:${isMonitored ? '#52c41a' : '#e61a23'};color:#fff;border:none;padding:6px 12px;border-radius:14px;font-size:12px;font-weight:bold;cursor:pointer;">
                ${isMonitored ? '✓ 监控中 (点击取消)' : '➕ 监控此商品最低价'}
            </button>
        </div>
        <table class="price-table">
            <thead><tr><th>类型</th><th>日期</th><th>价格</th><th>差价</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
    <style>body,table{font-family:"PingFang SC","Microsoft YaHei","Helvetica Neue",Helvetica,Arial,sans-serif;}.price-container{max-width:800px;margin:10px auto;padding:10px;font-size:13px;font-weight:bold;background:#FFF9F9;color:#333;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);}.price-table{width:100%;border-collapse:separate;border-spacing:0;border-radius:8px;overflow:hidden;}.price-table th{background:#e61a23;color:#fff;padding:12px;text-align:left;font-weight:bold;}.price-table td{padding:12px;border-bottom:1px solid #EEE;font-weight:bold;}.price-diff.up{color:#C91623;font-weight:bold;}.price-diff.down{color:#00aa00;font-weight:bold;}</style>
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
