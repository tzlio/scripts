/**
 * GLaDOS 自动签到与 Cookie 自动提取脚本 for Loon
 * 
 * 功能：
 * 1. 【自动抓取 Cookie】：在 Safari 登录或访问 glados.cloud 时，自动捕获 Cookie 并持久化存储至本地。
 * 2. 【自动签到】：定时任务自动读取持久化 Cookie 进行签到（兼容插件 Argument 手动输入）。
 * 3. 【状态查询】：查询账号邮箱与剩余会员天数。
 * 4. 【系统通知】：获取 Cookie 成功或每日签到后自动发送 iOS 系统通知。
 */

const isRequest = typeof $request !== "undefined";

if (isRequest) {
  // 1. 自动捕获并持久化保存 Cookie
  autoGetCookie();
} else {
  // 2. 定时任务执行自动签到
  checkin();
}

/**
 * 拦截请求提取 Cookie 并保存
 */
function autoGetCookie() {
  const headers = $request.headers || {};
  const cookieVal = headers["Cookie"] || headers["cookie"] || "";

  if (cookieVal && (cookieVal.includes("gld:sess") || cookieVal.includes("koa:sess") || cookieVal.includes("gld_"))) {
    const oldCookie = $persistentStore.read("glados_cookie");
    if (oldCookie !== cookieVal) {
      const isSuccess = $persistentStore.write(cookieVal, "glados_cookie");
      if (isSuccess) {
        console.log("[GLaDOS] 成功获取并持久化保存 Cookie");
        $notification.post(
          "GLaDOS Cookie 获取成功 🎉",
          "已完成持久化保存",
          "已自动记录最新 Cookie，后续定时签到将自动调用，无需手动填写！"
        );
      } else {
        console.log("[GLaDOS] 持久化存储写入失败");
        $notification.post("GLaDOS Cookie 保存失败 ❌", "持久化存储写入失败", "请检查 Loon 权限设置");
      }
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
      } catch (e) {}
    }
    if (arg) return arg;
  }

  return "";
}

function translateMessage(rawMessage) {
  if (!rawMessage) return "无返回信息 ❓";
  const msg = String(rawMessage).toLowerCase();
  
  if (msg.includes("today's observation logged") || msg.includes("return tomorrow")) {
    return "今日已完成签到，请明天再来！ 🔁";
  } else if (msg.includes("checkin! got") || (msg.includes("got ") && msg.includes("points"))) {
    try {
      const points = rawMessage.split("Got ")[1].split(" Points")[0];
      return `签到成功，获得 ${points} 积分 🎉`;
    } catch (e) {
      return `签到成功: ${rawMessage} 🎉`;
    }
  } else if (msg.includes("repeat") || msg.includes("already") || msg.includes("repeats")) {
    return "今日已完成签到，请明天再试 🔁";
  } else if (msg.includes("please try tomorrow")) {
    return "签到已记录，请明天再试 🤖";
  } else if (msg.includes("automated check-in detected")) {
    return "触发官方风控拦截，请在浏览器重新登录后更新 Cookie ⚠️";
  } else if (msg.includes("not logged in") || msg.includes("cookie") || msg.includes("forbidden")) {
    return "Cookie 已失效，请在 Safari 重新登录 glados.cloud 重新提取 ❌";
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

  const checkinUrl = "https://glados.cloud/api/user/checkin";
  const headers = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Content-Type": "application/json;charset=UTF-8",
    "Cookie": cookie,
    "Origin": "https://glados.cloud",
    "Referer": "https://glados.cloud/console/checkin",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  };

  const body = JSON.stringify({ token: "glados.cloud" });

  $httpClient.post({ url: checkinUrl, headers: headers, body: body }, (error, response, data) => {
    if (error) {
      console.log(`[GLaDOS] 签到网络请求失败: ${error}`);
      $notification.post("GLaDOS 签到异常 ❌", "网络请求失败", `${error}`);
      $done();
      return;
    }

    let signMsg = "";
    try {
      const res = JSON.parse(data);
      signMsg = translateMessage(res.message);
    } catch (e) {
      signMsg = `解析签到响应失败: ${data}`;
    }

    // 签到完成后查询账号状态
    getStatus(headers, signMsg);
  });
}

function getStatus(headers, signMsg) {
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

    const title = "GLaDOS 自动签到";
    const subTitle = email ? `${email} (${statusMsg})` : statusMsg;
    const detail = `${signMsg}`;

    console.log(`[GLaDOS] ${subTitle} - ${detail}`);
    $notification.post(title, subTitle, detail);
    $done();
  });
}

