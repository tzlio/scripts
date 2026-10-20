/*
脚本引用 https://raw.githubusercontent.com/githubdulong/Script/master/jd_price.js
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

// 场景 2: 抓取 CK (严格防空请求冲刷覆盖有效凭证)
if (url.includes(path2)) {
    const reqbody = $request.body;
    if (reqbody && reqbody.includes('c_mmbDevId')) {
        $.setdata(reqbody, manmanbuy_key);
        $.msg($.name, '获取ck成功🎉', '已成功捕获并保存完整凭据');
    }
}

// 场景 3: 按钮点击响应（本地瞬时 Mock，不再等待外网）
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
                <span style="font-size:12px;color:#666;">💡 提示：若频繁提示 token 错误，请打开【慢慢买】APP 重新点击一次【我的】刷新凭证。</span>
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

    // 采用 V1/V2 自动容灾链路，彻底解决单版本下偶发 token校验失败
    const ListPriceDetail = await fetchPriceDetailWithRetry(JD_Url);

    const exclude = new Set(['当前到手价', '历史最低价', '618价格', '双11价格', '30天最低价', '60天最低价', '180天最低价']);
    const list = ListPriceDetail.filter(i => exclude.has(i.Name));

    // 提取当前价（安全解析纯数字，杜绝 NaN）
    let curItem = ListPriceDetail.find(i => (i.Name === '当前到手价' || i.Name?.includes('当前') || i.ShowName?.includes('当前')) && i.Price);
    if (!curItem) curItem = list.find(i => i.Price) || ListPriceDetail[0] || {};
    const curPrice = parsePrice(curItem.Price || curItem.price);

    // 读取本地监控状态与历史底价
    const records = $.getjson(store_records_key) || {};
    const isMonitored = !!records[skuId];
    const savedLowest = parsePrice(records[skuId]?.lowest);
    // 底价保护：确保绝不输出 NaN
    const recordLowest = savedLowest > 0 ? savedLowest : (curPrice > 0 ? curPrice : '待获取');

    const html = Price_HTML(list, skuId, curPrice, isMonitored, recordLowest);
    const body = responseBody.replace("<body>", `<body>${html}`);
    return { body };
}

// V1/V2 自动容灾查询器（V1 失败自动切 V2，反之亦然）
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

// 全局纯数字价格安全清洗器（杜绝 NaN）
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
                        btn.style.background = '#e61a23';
                        btn.innerText = '➕ 监控此商品最低价';
                    }
                })
                .catch(err => {
                    alert('操作异常: ' + (err.message || '网络错误'));
                    btn.innerText = '重试';
                });
        }
    </script>`;
}

// 处理添加/移除监控（强化清洗，避免存入 NaN）
function handleToggle(toggleUrl) {
    const sku = toggleUrl.match(/sku=(\d+)/)?.[1];
    const rawP = toggleUrl.match(/price=([^&]+)/)?.[1];
    let price = parsePrice(rawP);

    let records = $.getjson(store_records_key) || {};
    let action = "";

    if (records[sku]) {
        delete records[sku];
        action = "removed";
    } else {
        records[sku] = { lowest: price > 0 ? price : 0, time: Date.now() };
        action = "added";
        $.msg($.name, '📌 已加入降价监控', `商品 ID: ${sku}${price > 0 ? `，当前基准底价: ¥${price}` : ''}`);
    }

    $.setjson(records, store_records_key);

    const mockPayload = {
        status: 200,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
        },
        body: JSON.stringify({ code: 200, action, lowest: records[sku]?.lowest })
    };

    if (typeof $response !== "undefined") {
        $done(mockPayload);
    } else {
        $done({ response: mockPayload });
    }
}

// 定时巡检任务
async function cronTask() {
    intCryptoJS();
    const records = $.getjson(store_records_key) || {};
    const skuList = Object.keys(records);

    if (!skuList.length) {
        $.log('当前无监控商品。');
        return;
    }

    $.log(`[定时巡检] 开始检查 ${skuList.length} 件监控商品...`);

    for (const skuId of skuList) {
        try {
            const JD_Url = `https://item.jd.com/${skuId}.html`;
            const ListPriceDetail = await fetchPriceDetailWithRetry(JD_Url);

            let curItem = ListPriceDetail.find(i => (i.Name === '当前到手价' || i.Name?.includes('当前') || i.ShowName?.includes('当前')) && i.Price);
            if (!curItem) curItem = ListPriceDetail[0] || {};
            const curPrice = parsePrice(curItem.Price || curItem.price);

            const item = records[skuId];
            const itemLowest = parsePrice(item?.lowest);

            if (curPrice > 0 && itemLowest > 0 && curPrice < itemLowest) {
                const drop = (itemLowest - curPrice).toFixed(2);
                const oldLowest = itemLowest;
                item.lowest = curPrice;

                $.msg(
                    `🎉 京东破底价: ${skuId}`,
                    `现价 ¥${curPrice} (降幅 -¥${drop})`,
                    `原底价 ¥${oldLowest} ➡️ 最新底价 ¥${curPrice}，点击直达`,
                    { openUrl: `openapp.jdmobile://virtual?params={"category":"jump","des":"productDetail","skuId":"${skuId}"}` }
                );
                $.log(`[创新低] ${skuId}: ¥${oldLowest} -> ¥${curPrice}`);
            } else {
                $.log(`[未创新低] ${skuId}: 现价 ¥${curPrice}, 记录底价 ¥${itemLowest}`);
            }

            await $.wait(1500);
        } catch (err) {
            $.logErr(`[巡检异常] ${skuId}: ${err.message || err}`);
        }
    }

    $.setjson(records, store_records_key);
}

// ===================== 慢慢买底层鉴权 (原版保持) =====================
async function mmbRequest(Params, url) {
    if (!$.manmanbuy) {
        $.manmanbuy = getck();
    }
    let payloadStr;
    if (typeof Params === 'string') {
        payloadStr = Params;
    } else {
        const SECRET_KEY = '3E41D1331F5DDAFCD0A38FE2D52FF66F';
        const requestBody = {
            ...$.manmanbuy,
            ...Params,
            t: Date.now().toString()
        };
        requestBody.token = md5(encodeURIComponent(SECRET_KEY + jsonToCustomString(requestBody) + SECRET_KEY)).toUpperCase();
        payloadStr = jsonToQueryString(requestBody);
    }
    const opt = {
        url,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
            "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 15_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 - mmbWebBrowse - ios"
        },
        body: payloadStr
    };
    return await httpRequest(opt);
}

function get_stteId(searchKey) {
    const url = 'https://apapia-common.manmanbuy.com/SiteCommand/parse';
    const payload = { methodName: "commonMethod", searchKey };
    return mmbRequest(payload, url);
}

function get_spbh(link, stteId, version) {
    const base = 'https://apapia-history-weblogic.manmanbuy.com/basic';
    const url = version === "V2" ? `${base}/v2/getItemBasicInfo` : `${base}/getItemBasicInfo`;
    const payload = { methodName: "getHistoryInfoJava", searchKey: link, ...(version === "V2" && {stteId}) };
    return mmbRequest(payload, url);
}

function get_jiagequshi(link, spbh) {
    const url = "https://apapia-history-weblogic.manmanbuy.com/history/v2/getHistoryTrend";
    const payload = { methodName: "getHistoryTrend2021", url: link, spbh: spbh };
    return mmbRequest(payload, url);
}

function get_priceRemark(jiagequshiyh) {
    const url = "https://apapia-history-weblogic.manmanbuy.com/history/priceRemark";
    const payload = { "methodName": "priceRemarkJava", "jiagequshiyh": jiagequshiyh };
    return mmbRequest(payload, url);
}

function int_ck(Params){
    const baseParams = {jsoncallback: "?", c_individ: "", c_appver: "", c_ostype: "", c_osver: "", c_devid: "", c_mmbDevId: "", c_systemDevId: "", c_fixDevId: "", c_devmodel: "", c_brand: "", c_operator: "", c_engine: "", c_session: "", c_ddToken: "", c_ctrl: "", c_win: "", c_dp: "", c_safearea: "", c_firstchannel: "", c_firstquerendate: "", c_fristversion: "", c_channel: "", c_uuid: "", c_ssid: "", c_did: "", c_theme: "", c_jpush: "", c_mmbncid: "", sm_deviceid: ""};
    const mergedParams = {
        ...baseParams,
        ...Object.fromEntries(
            Object.entries(Params).filter(([key]) => key in baseParams)
        )
    };
    return mergedParams;
}

function getck() {
    const ck = $.getdata(manmanbuy_key);
    if (!ck) {
        $.msg($.name, '请先打开【慢慢买】APP', '请确保已成功获取ck');
        throw new Error(`请先打开【慢慢买】APP,点击我的，获取ck`);
    }
    const Params = parseQueryString(ck);
    if (!Params || !Params.c_mmbDevId) {
        $.msg($.name, '数据异常', '请联系脚本作者检查ck格式');
        throw new Error(`请联系脚本作者检查ck格式`);
    }
    return int_ck(Params);
}

async function httpRequest(options) {
    try {
        options = options.url ? options : { url: options };
        const _method = options?._method || ('body' in options ? 'post' : 'get');
        const _respType = options?._respType || 'body';
        const _timeout = options?._timeout || 15e3;
        const _http = [
            new Promise((_, reject) => setTimeout(() => reject(`⛔️ 请求超时: ${options['url']}`), _timeout)),
            new Promise((resolve) => {
                $[_method.toLowerCase()](options, (error, response, data) => {
                    error && $.log($.toStr(error));
                    if (_respType !== 'all') {
                        resolve($.toObj(response?.[_respType], response?.[_respType]));
                    } else {
                        resolve(response);
                    }
                });
            })
        ];
        return await Promise.race(_http);
    } catch (err) {
        $.logErr(err);
    }
}

function parseQueryString(queryString) {
    const jsonObject = {};
    const pairs = queryString.split('&');
    pairs.forEach(pair => {
        const [key, value] = pair.split('=');
        jsonObject[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
    return jsonObject;
}

function jsonToQueryString(jsonObject) {
    return Object.keys(jsonObject).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(jsonObject[key])}`).join('&');
}

function jsonToCustomString(jsonObject){
    return Object.keys(jsonObject).filter(key=>jsonObject[key]!==''&&key.toLowerCase()!=='token').sort().map(key=>`${key.toUpperCase()}${jsonObject[key].toUpperCase()}`).join('');
}

function intCryptoJS(){CryptoJS=function(t,r){var n;if("undefined"!=typeof window&&window.crypto&&(n=window.crypto),"undefined"!=typeof self&&self.crypto&&(n=self.crypto),"undefined"!=typeof globalThis&&globalThis.crypto&&(n=globalThis.crypto),!n&&"undefined"!=typeof window&&window.msCrypto&&(n=window.msCrypto),!n&&"undefined"!=typeof global&&global.crypto&&(n=global.crypto),!n&&"function"==typeof require)try{n=require("crypto")}catch(t){}var e=function(){if(n){if("function"==typeof n.getRandomValues)try{return n.getRandomValues(new Uint32Array(1))[0]}catch(t){}if("function"==typeof n.randomBytes)try{return n.randomBytes(4).readInt32LE()}catch(t){}}throw new Error("Native crypto module could not be used to get secure random number.")},i=Object.create||function(){function t(){}return function(r){var n;return t.prototype=r,n=new t,t.prototype=null,n}}(),o={},a=o.lib={},s=a.Base={extend:function(t){var r=i(this);return t&&r.mixIn(t),r.hasOwnProperty("init")&&this.init!==r.init||(r.init=function(){r.$super.init.apply(this,arguments)}),r.init.prototype=r,r.$super=this,r},create:function(){var t=this.extend();return t.init.apply(t,arguments),t},init:function(){},mixIn:function(t){for(var r in t)t.hasOwnProperty(r)&&(this[r]=t[r]);t.hasOwnProperty("toString")&&(this.toString=t.toString)},clone:function(){return this.init.prototype.extend(this)}},c=a.WordArray=s.extend({init:function(t,r){t=this.words=t||[],this.sigBytes=null!=r?r:4*t.length},toString:function(t){return(t||f).stringify(this)},concat:function(t){var r=this.words,n=t.words,e=this.sigBytes,i=t.sigBytes;if(this.clamp(),e%4)for(var o=0;o<i;o++){var a=n[o>>>2]>>>24-o%4*8&255;r[e+o>>>2]|=a<<24-(e+o)%4*8}else for(var s=0;s<i;s+=4)r[e+s>>>2]=n[s>>>2];return this.sigBytes+=i,this},clamp:function(){var r=this.words,n=this.sigBytes;r[n>>>2]&=4294967295<<32-n%4*8,r.length=t.ceil(n/4)},clone:function(){var t=s.clone.call(this);return t.words=this.words.slice(0),t},random:function(r){var n,i=[],o=function(r){r=r;var n=987654321,e=4294967295;return function(){var i=((n=36969*(65535&n)+(n>>16)&e)<<16)+(r=18e3*(65535&r)+(r>>16)&e)&e;return i/=4294967296,(i+=.5)*(t.random()>.5?1:-1)}},a=!1;try{e(),a=!0}catch(t){}for(var s,u=0;u<r;u+=4)a?i.push(e()):(s=987654071*(n=o(4294967296*(s||t.random())))(),i.push(4294967296*n()|0));return new c.init(i,r)}}),u=o.enc={},f=u.Hex={stringify:function(t){for(var r=t.words,n=t.sigBytes,e=[],i=0;i<n;i++){var o=r[i>>>2]>>>24-i%4*8&255;e.push((o>>>4).toString(16)),e.push((15&o).toString(16))}return e.join("")},parse:function(t){for(var r=t.length,n=[],e=0;e<r;e+=2)n[e>>>3]|=parseInt(t.substr(e,2),16)<<24-e%8*4;return new c.init(n,r/2)}},h=u.Latin1={stringify:function(t){for(var r=t.words,n=t.sigBytes,e=[],i=0;i<n;i++){var o=r[i>>>2]>>>24-i%4*8&255;e.push(String.fromCharCode(o))}return e.join("")},parse:function(t){for(var r=t.length,n=[],e=0;e<r;e++)n[e>>>2]|=(255&t.charCodeAt(e))<<24-e%4*8;return new c.init(n,r)}},p=u.Utf8={stringify:function(t){try{return decodeURIComponent(escape(h.stringify(t)))}catch(t){throw new Error("Malformed UTF-8 data")}},parse:function(t){return h.parse(unescape(encodeURIComponent(t)))}},d=a.BufferedBlockAlgorithm=s.extend({reset:function(){this._data=new c.init,this._nDataBytes=0},_append:function(t){"string"==typeof t&&(t=p.parse(t)),this._data.concat(t),this._nDataBytes+=t.sigBytes},_process:function(r){var n,e=this._data,i=e.words,o=e.sigBytes,a=this.blockSize,s=o/(4*a),u=(s=r?t.ceil(s):t.max((0|s)-this._minBufferSize,0))*a,f=t.min(4*u,o);if(u){for(var h=0;h<u;h+=a)this._doProcessBlock(i,h);n=i.splice(0,u),e.sigBytes-=f}return new c.init(n,f)},clone:function(){var t=s.clone.call(this);return t._data=this._data.clone(),t},_minBufferSize:0}),l=(a.Hasher=d.extend({cfg:s.extend(),init:function(t){this.cfg=this.cfg.extend(t),this.reset()},reset:function(){d.reset.call(this),this._doReset()},update:function(t){return this._append(t),this._process(),this},finalize:function(t){return t&&this._append(t),this._doFinalize()},blockSize:16,_createHelper:function(t){return function(r,n){return new t.init(n).finalize(r)}},_createHmacHelper:function(t){return function(r,n){return new l.HMAC.init(t,n).finalize(r)}}}),o.algo={});return o}(Math);!function(t){var r=CryptoJS,n=r.lib,e=n.WordArray,i=n.Hasher,o=r.algo,a=[];!function(){for(var r=0;r<64;r++)a[r]=4294967296*t.abs(t.sin(r+1))|0}();var s=o.MD5=i.extend({_doReset:function(){this._hash=new e.init([1732584193,4023233417,2562383102,271733878])},_doProcessBlock:function(t,r){for(var n=0;n<16;n++){var e=r+n,i=t[e];t[e]=16711935&(i<<8|i>>>24)|4278255360&(i<<24|i>>>8)}var o=this._hash.words,s=t[r+0],p=t[r+1],d=t[r+2],l=t[r+3],y=t[r+4],v=t[r+5],g=t[r+6],w=t[r+7],_=t[r+8],m=t[r+9],B=t[r+10],b=t[r+11],C=t[r+12],S=t[r+13],x=t[r+14],A=t[r+15],H=o[0],z=o[1],M=o[2],D=o[3];z=h(z=h(z=h(z=h(z=f(z=f(z=f(z=f(z=u(z=u(z=u(z=u(z=c(z=c(z=c(z=c(z,M=c(M,D=c(D,H=c(H,z,M,D,s,7,a[0]),z,M,p,12,a[1]),H,z,d,17,a[2]),D,H,l,22,a[3]),M=c(M,D=c(D,H=c(H,z,M,D,y,7,a[4]),z,M,v,12,a[5]),H,z,g,17,a[6]),D,H,w,22,a[7]),M=c(M,D=c(D,H=c(H,z,M,D,_,7,a[8]),z,M,m,12,a[9]),H,z,B,17,a[10]),D,H,b,22,a[11]),M=c(M,D=c(D,H=c(H,z,M,D,C,7,a[12]),z,M,S,12,a[13]),H,z,x,17,a[14]),D,H,A,22,a[15]),M=u(M,D=u(D,H=u(H,z,M,D,p,5,a[16]),z,M,g,9,a[17]),H,z,b,14,a[18]),D,H,s,20,a[19]),M=u(M,D=u(D,H=u(H,z,M,D,v,5,a[20]),z,M,B,9,a[21]),H,z,A,14,a[22]),D,H,y,20,a[23]),M=u(M,D=u(D,H=u(H,z,M,D,m,5,a[24]),z,M,x,9,a[25]),H,z,l,14,a[26]),D,H,_,20,a[27]),M=u(M,D=u(D,H=u(H,z,M,D,S,5,a[28]),z,M,d,9,a[29]),H,z,w,14,a[30]),D,H,C,20,a[31]),M=f(M,D=f(D,H=f(H,z,M,D,v,4,a[32]),z,M,_,11,a[33]),H,z,b,16,a[34]),D,H,x,23,a[35]),M=f(M,D=f(D,H=f(H,z,M,D,p,4,a[36]),z,M,y,11,a[37]),H,z,w,16,a[38]),D,H,B,23,a[39]),M=f(M,D=f(D,H=f(H,z,M,D,S,4,a[40]),z,M,s,11,a[41]),H,z,l,16,a[42]),D,H,g,23,a[43]),M=f(M,D=f(D,H=f(H,z,M,D,m,4,a[44]),z,M,C,11,a[45]),H,z,A,16,a[46]),D,H,d,23,a[47]),M=h(M,D=h(D,H=h(H,z,M,D,s,6,a[48]),z,M,w,10,a[49]),H,z,x,15,a[50]),D,H,v,21,a[51]),M=h(M,D=h(D,H=h(H,z,M,D,C,6,a[52]),z,M,l,10,a[53]),H,z,B,15,a[54]),D,H,p,21,a[55]),M=h(M,D=h(D,H=h(H,z,M,D,_,6,a[56]),z,M,A,10,a[57]),H,z,g,15,a[58]),D,H,S,21,a[59]),M=h(M,D=h(D,H=h(H,z,M,D,y,6,a[60]),z,M,b,10,a[61]),H,z,d,15,a[62]),D,H,m,21,a[63]),o[0]=o[0]+H|0,o[1]=o[1]+z|0,o[2]=o[2]+M|0,o[3]=o[3]+D|0},_doFinalize:function(){var r=this._data,n=r.words,e=8*this._nDataBytes,i=8*r.sigBytes;n[i>>>5]|=128<<24-i%32;var o=t.floor(e/4294967296),a=e;n[15+(i+64>>>9<<4)]=16711935&(o<<8|o>>>24)|4278255360&(o<<24|o>>>8),n[14+(i+64>>>9<<4)]=16711935&(a<<8|a>>>24)|4278255360&(a<<24|a>>>8),r.sigBytes=4*(n.length+1),this._process();for(var s=this._hash,c=s.words,u=0;u<4;u++){var f=c[u];c[u]=16711935&(f<<8|f>>>24)|4278255360&(f<<24|f>>>8)}return s},clone:function(){var t=i.clone.call(this);return t._hash=this._hash.clone(),t}});function c(t,r,n,e,i,o,a){var s=t+(r&n|~r&e)+i+a;return(s<<o|s>>>32-o)+r}function u(t,r,n,e,i,o,a){var s=t+(r&e|n&~e)+i+a;return(s<<o|s>>>32-o)+r}function f(t,r,n,e,i,o,a){var s=t+(r^n^e)+i+a;return(s<<o|s>>>32-o)+r}function h(t,r,n,e,i,o,a){var s=t+(n^(r|~e))+i+a;return(s<<o|s>>>32-o)+r}r.MD5=i._createHelper(s),r.HmacMD5=i._createHmacHelper(s)}(Math),function(){var t=CryptoJS,r=t.lib.WordArray;t.enc.Base64={stringify:function(t){var r=t.words,n=t.sigBytes,e=this._map;t.clamp();for(var i=[],o=0;o<n;o+=3)for(var a=(r[o>>>2]>>>24-o%4*8&255)<<16|(r[o+1>>>2]>>>24-(o+1)%4*8&255)<<8|r[o+2>>>2]>>>24-(o+2)%4*8&255,s=0;s<4&&o+.75*s<n;s++)i.push(e.charAt(a>>>6*(3-s)&63));var c=e.charAt(64);if(c)for(;i.length%4;)i.push(c);return i.join("")},parse:function(t){var n=t.length,e=this._map,i=this._reverseMap;if(!i){i=this._reverseMap=[];for(var o=0;o<e.length;o++)i[e.charCodeAt(o)]=o}var a=e.charAt(64);if(a){var s=t.indexOf(a);-1!==s&&(n=s)}return function(t,n,e){for(var i=[],o=0,a=0;a<n;a++)if(a%4){var s=e[t.charCodeAt(a-1)]<<a%4*2,c=e[t.charCodeAt(a)]>>>6-a%4*2;i[o>>>2]|=(s|c)<<24-o%4*8,o++}return r.create(i,o)}(t,n,i)},_map:"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="}}();};function md5(word){return CryptoJS.MD5(word).toString();}
