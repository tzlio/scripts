/**
 * GLaDOS 自动签到与 Cookie 自动提取脚本 for Loon
 * 
 * 功能：
 * 1. 【自动抓取凭据】：在浏览器登录或访问 glados.cloud 时，自动捕获 Cookie 及真实 User-Agent 并持久化存储至本地。
 * 2. 【智能防风控】：根据真实浏览器指纹（Safari / Chrome / Edge）动态构建请求头，消除指纹冲突，避免触发官方自动化检测。
 * 3. 【自动签到】：定时任务自动读取持久化凭据进行签到（兼容插件 Argument 手动输入）。
 * 4. 【状态查询】：查询账号邮箱、剩余会员天数与连续签到天数。
 * 5. 【系统通知】：获取凭据成功或每日签到后自动发送 iOS 系统通知。
 */

const isRequest = typeof $request !== "undefined";

if (isRequest) {
  // 1. 自动捕获并持久化保存 Cookie 与 User-Agent
  autoGetCookie();
} else {
  // 2. 定时任务执行自动签到
  checkin();
}

/**
 * 拦截请求提取 Cookie 与 User-Agent 并保存
 */
function autoGetCookie() {
  const headers = $request.headers || {};
  const cookieVal = headers["Cookie"] || headers["cookie"] || "";
  const uaVal = headers["User-Agent"] || headers["user-agent"] || "";

  if (cookieVal && (cookieVal.includes("gld:sess") || cookieVal.includes("koa:sess") || cookieVal.includes("gld_"))) {
    const oldCookie = $persistentStore.read("glados_cookie");
    let needNotify = false;

    if (oldCookie !== cookieVal) {
      $persistentStore.write(cookieVal, "glados_cookie");
      needNotify = true;
    }

    if (uaVal) {
      $persistentStore.write(uaVal, "glados_ua");
    }

    if (needNotify) {
      console.log("[GLaDOS] 成功获取并持久化保存最新 Cookie 与浏览器指纹");
      $notification.post(
        "GLaDOS 凭据更新成功 🎉",
        "已持久化保存 Cookie 与设备指纹",
        "已自动更新最新凭据，防风控签名已同步，后续定时任务将自动调用！"
      );
    }
  }
  $done({});
}

/**
 * 读取 Cookie（优先读取自动抓取持久化的 Cookie，其次读取 Argument 手动输入的 Cookie）
 */
function getCookie() {
  // 1. 优先从持久化存储获取
  const savedCookie = typeof $persistentStore !== "undefined" ? $persistentStore.read("glados_cookie") : "";
  if (savedCookie) {
    return savedCookie.trim();
  }

  // 2. 其次从插件 Argument 获取（兼容手动配置）
  if (typeof $argument !== "undefined" && $argument) {
    let arg = $argument.trim();
    if (arg.startsWith("{") && arg.endsWith("}")) {
      try {
        const obj = JSON.parse(arg);
        if (obj.cookie) return obj.cookie.trim();
      } catch (e) { }
    }
    if (arg) return arg;
  }

  return "";
}

/**
 * 智能构建防风控请求头
 * 若捕获到真实 Safari UA，则不伪造 Client Hints (Sec-Ch-Ua)，消除指纹与网络栈冲突；
 * 若未捕获或为 Chromium，则使用与最新浏览器一致的 Edge 155 标头。
 */
function buildHeaders(cookie) {
  const savedUa = typeof $persistentStore !== "undefined" ? $persistentStore.read("glados_ua") : "";
  const isSafari = savedUa && (savedUa.includes("Safari") && !savedUa.includes("Chrome") && !savedUa.includes("Edg"));

  if (savedUa && isSafari) {
    // 真实 iOS / macOS Safari 标头（不含 Sec-Ch-Ua 避免指纹伪造暴露）
    return {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh-Hans;q=0.9,en;q=0.8",
      "Content-Type": "application/json;charset=UTF-8",
      "Cookie": cookie,
      "Origin": "https://glados.cloud",
      "Referer": "https://glados.cloud/console/checkin",
      "User-Agent": savedUa
    };
  }

  // 默认现代 Edge / Chrome 防风控请求头（与官方最新抓包完全一致）
  const userAgent = savedUa || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0";
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
    "Content-Type": "application/json;charset=UTF-8",
    "Cookie": cookie,
    "Origin": "https://glados.cloud",
    "Referer": "https://glados.cloud/console/checkin",
    "Sec-Ch-Ua": '"Microsoft Edge";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Priority": "u=1, i",
    "User-Agent": userAgent
  };
}

function parseCheckinResponse(res) {
  if (!res) return "无返回信息 ❓";

  const code = res.code;
  const rawMessage = res.message || "";
  const msg = String(rawMessage).toLowerCase();

  // 1. 成功签到
  if (code === 0 || msg.includes("checkin! got") || (msg.includes("got ") && msg.includes("points"))) {
    let points = res.points !== undefined ? res.points : "";
    if (!points && rawMessage.includes("Got ")) {
      try {
        points = rawMessage.split("Got ")[1].split(" Points")[0];
      } catch (e) { }
    }
    const streak = res.streak ? ` (已连签 ${res.streak} 天)` : "";
    return points ? `签到成功，获得 ${points} 积分 🎉${streak}` : `签到成功: ${rawMessage} 🎉`;
  }

  // 2. 今日已签过
  if (code === 1 || msg.includes("today's observation logged") || msg.includes("return tomorrow") || msg.includes("repeat") || msg.includes("already")) {
    const streak = res.streak ? ` (已连签 ${res.streak} 天)` : "";
    return `今日已完成签到，请明天再来！ 🔁${streak}`;
  }

  // 3. 风控与会话失效
  if (msg.includes("automated check-in detected")) {
    return "触发官方风控(请在 Loon 中将 glados.cloud 设为 DIRECT 直连，并在 Safari 重新登录刷新) ⚠️";
  } else if (msg.includes("not logged in") || msg.includes("cookie") || msg.includes("forbidden")) {
    return "Cookie 已失效，请在 Safari 重新登录 glados.cloud 刷新凭据 ❌";
  }

  return rawMessage;
}

function checkin() {
  const cookie = getCookie();
  if (!cookie) {
    const tip = "未找到 Cookie！请先在 Safari 浏览器打开并登录 glados.cloud，Loon 将自动获取保存；或在插件设置中手动填写。";
    console.log(`[GLaDOS] ${tip}`);
    $notification.post("GLaDOS 签到失败 ❌", "未配置 Cookie", tip);
    $done();
    return;
  }

  const headers = buildHeaders(cookie);

  // 1. 先查询账号状态
  const statusUrl = "https://glados.cloud/api/user/status";
  $httpClient.get({ url: statusUrl, headers: headers }, (error, response, data) => {
    let statusMsg = "";
    let email = "";
    if (error) {
      statusMsg = "获取账号状态网络失败";
    } else {
      try {
        const res = JSON.parse(data);
        if (res.code === 0 && res.data) {
          email = res.data.email || "";
          const leftDays = parseFloat(res.data.leftDays || 0);
          statusMsg = `剩余 ${Number.isInteger(leftDays) ? leftDays : leftDays.toFixed(1)} 天`;
        } else {
          statusMsg = res.message || "获取状态异常";
        }
      } catch (e) {
        statusMsg = "解析账号状态失败";
      }
    }

    // 2. 执行签到请求
    executeSign(headers, email, statusMsg);
  });
}

function executeSign(headers, email, statusMsg) {
  const checkinUrl = "https://glados.cloud/api/user/checkin";
  const body = JSON.stringify({ token: "glados.cloud" });

  $httpClient.post({ url: checkinUrl, headers: headers, body: body }, (error, response, data) => {
    let signMsg = "";
    if (error) {
      signMsg = `网络请求失败: ${error}`;
    } else {
      try {
        const res = JSON.parse(data);
        signMsg = parseCheckinResponse(res);
      } catch (e) {
        signMsg = `解析响应失败: ${data}`;
      }
    }

    const title = "GLaDOS 自动签到";
    const subTitle = email ? `${email} (${statusMsg})` : statusMsg;
    const detail = `${signMsg}`;

    console.log(`[GLaDOS] ${subTitle} - ${detail}`);
    $notification.post(title, subTitle, detail);
    $done();
  });
}


