// _worker.js
import { connect } from "cloudflare:sockets";
var userID = "11e1a114-6201-4ceb-ba4a-0d0a39a429a7";
var proxyIP = "";
var hostnames = ["acuvpn.xyz"];
if (!isValidUUID(userID)) {
  throw new Error("uuid is not valid");
}
var worker_default = {
  /**
   * @param {import("@cloudflare/workers-types").Request} request
   * @param {{UUID: string, PROXYIP: string}} env
   * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, ctx) {
    try {
      userID = env.uuid || userID;
      proxyIP = env.proxyip || proxyIP;
      const upgradeHeader = request.headers.get("Upgrade");
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        const url = new URL(request.url);
        switch (url.pathname) {
          case "/cf":
            return new Response(JSON.stringify(request.cf, null, 4), {
              status: 200,
              headers: {
                "Content-Type": "application/json;charset=utf-8"
              }
            });
          case `/vless`:
            {
              const vlessConfig = await getVLESSConfig(userID, request.headers.get("Host"), proxyIP);
              return new Response(`${vlessConfig}`, {
                status: 200,
                headers: {
                  "Content-Type": "text/html; charset=utf-8"
                }
              });
            }
            ;
          default:
            const randomHostname = hostnames[Math.floor(Math.random() * hostnames.length)];
            const newHeaders = new Headers(request.headers);
            newHeaders.set("cf-connecting-ip", "1.2.3.4");
            newHeaders.set("x-forwarded-for", "1.2.3.4");
            newHeaders.set("x-real-ip", "1.2.3.4");
            newHeaders.set("referer", "https://www.google.com/search?q=edtunnel");
            const proxyUrl = "https://" + randomHostname + url.pathname + url.search;
            let modifiedRequest = new Request(proxyUrl, {
              method: request.method,
              headers: newHeaders,
              body: request.body,
              redirect: "manual"
            });
            const proxyResponse = await fetch(modifiedRequest, { redirect: "manual" });
            if ([301, 302].includes(proxyResponse.status)) {
              return new Response(`Redirects to ${randomHostname} are not allowed.`, {
                status: 403,
                statusText: "Forbidden"
              });
            }
            return proxyResponse;
        }
      } else {
        return await vlessOverWSHandler(request);
      }
    } catch (err) {
      let e = err;
      return new Response(e.toString());
    }
  }
};
async function vlessOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = "";
  let portWithRandomLog = "";
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || "");
  };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = {
    value: null
  };
  let udpStreamWrite = null;
  let isDns = false;
  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      if (remoteSocketWapper.value) {
        const writer = remoteSocketWapper.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const {
        hasError,
        message,
        portRemote = 443,
        addressRemote = "",
        rawDataIndex,
        vlessVersion = new Uint8Array([0, 0]),
        isUDP
      } = processVlessHeader(chunk, userID);
      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? "udp " : "tcp "} `;
      if (hasError) {
        throw new Error(message);
        return;
      }
      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
        } else {
          throw new Error("UDP proxy only enable for DNS which is port 53");
          return;
        }
      }
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isDns) {
        const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
    },
    close() {
      log(`readableWebSocketStream is close`);
    },
    abort(reason) {
      log(`readableWebSocketStream is abort`, JSON.stringify(reason));
    }
  })).catch((err) => {
    log("readableWebSocketStream pipeTo error", err);
  });
  return new Response(null, {
    status: 101,
    // @ts-ignore
    webSocket: client
  });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
  async function connectAndWrite(address, port) {
    const tcpSocket2 = connect({
      hostname: address,
      port
    });
    remoteSocket.value = tcpSocket2;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket2.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket2;
  }
  async function retry() {
    const tcpSocket2 = await connectAndWrite(proxyIP || addressRemote, portRemote);
    tcpSocket2.closed.catch((error) => {
      console.log("retry tcpSocket closed error", error);
    }).finally(() => {
      safeCloseWebSocket(webSocket);
    });
    remoteSocketToWS(tcpSocket2, webSocket, vlessResponseHeader, null, log);
  }
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener("message", (event) => {
        if (readableStreamCancel) {
          return;
        }
        const message = event.data;
        controller.enqueue(message);
      });
      webSocketServer.addEventListener(
        "close",
        () => {
          safeCloseWebSocket(webSocketServer);
          if (readableStreamCancel) {
            return;
          }
          controller.close();
        }
      );
      webSocketServer.addEventListener(
        "error",
        (err) => {
          log("webSocketServer has error");
          controller.error(err);
        }
      );
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    pull(controller) {
    },
    cancel(reason) {
      if (readableStreamCancel) {
        return;
      }
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    }
  });
  return stream;
}
function processVlessHeader(vlessBuffer, userID2) {
  if (vlessBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: "invalid data"
    };
  }
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  let isValidUser = false;
  let isUDP = false;
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID2) {
    isValidUser = true;
  }
  if (!isValidUser) {
    return {
      hasError: true,
      message: "invalid user"
    };
  }
  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(
    vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
  )[0];
  if (command === 1) {
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`
    };
  }
  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(
    vlessBuffer.slice(addressIndex, addressIndex + 1)
  );
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = "";
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join(".");
      break;
    case 2:
      addressLength = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(":");
      break;
    default:
      return {
        hasError: true,
        message: `invild  addressType is ${addressType}`
      };
  }
  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`
    };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP
  };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
  let remoteChunkCount = 0;
  let chunks = [];
  let vlessHeader = vlessResponseHeader;
  let hasIncomingData = false;
  await remoteSocket.readable.pipeTo(
    new WritableStream({
      start() {
      },
      /**
       * 
       * @param {Uint8Array} chunk 
       * @param {*} controller 
       */
      async write(chunk, controller) {
        hasIncomingData = true;
        if (webSocket.readyState !== WS_READY_STATE_OPEN) {
          controller.error(
            "webSocket.readyState is not open, maybe close"
          );
        }
        if (vlessHeader) {
          webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
          vlessHeader = null;
        } else {
          webSocket.send(chunk);
        }
      },
      close() {
        log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
      },
      abort(reason) {
        console.error(`remoteConnection!.readable abort`, reason);
      }
    })
  ).catch((error) => {
    console.error(
      `remoteSocketToWS has exception `,
      error.stack || error
    );
    safeCloseWebSocket(webSocket);
  });
  if (hasIncomingData === false && retry) {
    log(`retry`);
    retry();
  }
}
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { error: null };
  }
  try {
    base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
var WS_READY_STATE_OPEN = 1;
var WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error("safeCloseWebSocket error", error);
  }
}
var byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    start(controller) {
    },
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPakcetLength)
        );
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
    flush(controller) {
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const resp = await fetch(
        "https://1.1.1.1/dns-query",
        {
          method: "POST",
          headers: {
            "content-type": "application/dns-message"
          },
          body: chunk
        }
      );
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      const udpSizeBuffer = new Uint8Array([udpSize >> 8 & 255, udpSize & 255]);
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        log(`doh success and dns message length is ${udpSize}`);
        if (isVlessHeaderSent) {
          webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
        } else {
          webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
          isVlessHeaderSent = true;
        }
      }
    }
  })).catch((error) => {
    log("dns udp has error" + error);
  });
  const writer = transformStream.writable.getWriter();
  return {
    /**
     * 
     * @param {Uint8Array} chunk 
     */
    write(chunk) {
      writer.write(chunk);
    }
  };
}
async function getVLESSConfig(userID2, hostName, proxyIP2) {
  try {
    const response = await fetch(`https://ipwhois.app/json/${proxyIP2}`);
    const data = await response.json();
    const proxyip = data.proxyStatus;
    const isp = data.isp;
    const country = data.country;
    const city = data.city;
    const vlessTls = `vless://${userID2}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2Fvless-ws#${isp} (Noir7R)`;
    const vlessNtls = `vless://${userID2}@${hostName}:80?path=%2Fvless-ws&security=none&encryption=none&host=${hostName}&fp=randomized&type=ws&sni=${hostName}#${isp} (Noir7R)`;
    const vlessTlsFormatted = vlessTls.replace(/ /g, "+");
    const vlessNtlsFormatted = vlessNtls.replace(/ /g, "+");
    return `<!DOCTYPE html>
<html lang="en" >
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width; initial-scale=1.0; maximum-scale=1.0;" />
  <title>Noir7R</title>
  <style>
  @import url("https://fonts.googleapis.com/css2?family=Lato:wght@400;700&display=swap");
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

.black-theme {
  display: flex;
  justify-content: center;
  align-items: center;
  background: url('https://raw.githubusercontent.com/linkid22/bg/main/island-night-moon-scenery-digital-art-phone-wallpaper-4k-uhdpaper.com-289%400%40j.jpg') no-repeat center center fixed;
  background-size: cover;
  position: relative;
  min-height: 100vh;
  overflow: hidden;
  font-family: "Lato", sans-serif;
  letter-spacing: 0.5px;
  font-weight: 400;
}
.black-theme:before {
  position: absolute;
  content: "";
  left: 40%;
  bottom: -40%;
  width: auto;
  height: auto;
  border-radius: 50%;
}
.card-content {
    /* Opsi tambahan untuk card content, jika diperlukan */
}
.black-theme .card {
  overflow-y: auto; 
  max-height: 530px;
  max-width: 400px;
  box-shadow: 0 15px 35px rgba(0, 0, 0, 0.5);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px);
  
}
.black-theme .card .card__top {
  height: 155px;
  position: relative;
}
.black-theme .card .card__top img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.black-theme .card .card__top .profile__photo {
  width: 130px;
  height: 130px;
  position: absolute;
  bottom: -60px;
  left: 50%;
  transform: translatex(-50%);
}
.black-theme .card .card__top .profile__photo img {
  width: 100%;
  border-radius: 50%;
  height: 100%;
  object-fit: cover;
  border: 7px solid rgba(0, 0, 0, 0.35);
}
.black-theme .card .card__content {
  text-align: center;
  color: #fff;
  padding: 5em 1em;
  word-wrap: break-word;
}
.black-theme .card .card__content h2 {
  font-weight: 700;
  font-size: 24px;
}
.black-theme .card .card__content h3 {
  font-weight: 400;
  margin: 5px 0 30px;
  font-size: 16px;
}
.black-theme .card .card__content p {
  word-wrap: break-word;
  text-align: left;
}
.black-theme .card .card__content p span {
  margin-right: 10px;
}
.black-theme .card .card__content p a {
  text-decoration: none;
  color: #fff;
}
.black-theme .card .card__content p a:hover {
  text-decoration: underline;
}
.black-theme .card .card__content p + p {
  margin-top: 10px;
}
.black-theme .card a.button {
  text-decoration: none;
  color: #fff;
  background: rgba(0, 0, 0, 0.85);
  padding: 9px 30px 10px 30px;
  display: inline-block;
  margin-top: 2em;
}
.black-theme .card a.button:hover {
  background: rgba(0, 0, 0, 0.7);
}

.white-theme {
  display: flex;
  justify-content: center;
  align-items: center;
  background: url('https://raw.githubusercontent.com/linkid22/angel/main/Houshou_Marine_100604237.jpg') no-repeat center center fixed;
  background-size: cover;
  position: relative;
  min-height: 100vh;
  overflow: hidden;
  font-family: "Lato", sans-serif;
  letter-spacing: 0.5px;
  font-weight: 400;
}
.white-theme:before {
  position: absolute;
  content: "";
  left: 40%;
  bottom: -40%;
  background: linear-gradient(135deg, #3fe2f2 0%, #43dbc0 24%, #3cabe8 91%);
  border-radius: 50%;
}
.white-theme .card {
  overflow-y: auto; 
  max-height: 530px;
  max-width: 400px;
  background: rgba(255, 255, 255, 0.3);
  box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
  backdrop-filter: blur(4px);
  border-radius: 10px;
}
.white-theme .card .card__top {
  height: 155px;
  position: relative;
}
.white-theme .card .card__top img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.white-theme .card .card__top .profile__photo {
  width: 130px;
  height: 130px;
  position: absolute;
  bottom: -60px;
  left: 50%;
  transform: translatex(-50%);
}
.white-theme .card .card__top .profile__photo img {
  width: 100%;
  border-radius: 50%;
  height: 100%;
  object-fit: cover;
  border: 8px solid rgba(255, 255, 255, 0.55);
}
.white-theme .card .card__content {
  text-align: center;
  color: rgba(0, 0, 0, 0.85);
  padding: 5em 1em;
}
.white-theme .card .card__content h2 {
  font-weight: 700;
  font-size: 24px;
}
.white-theme .card .card__content h3 {
  font-weight: 400;
  margin: 5px 0 30px;
  font-size: 16px;
}
.white-theme .card .card__content p {
  text-align: left;
}
.white-theme .card .card__content p span {
  margin-right: 10px;
}
.white-theme .card .card__content p a {
  text-decoration: none;
  color: rgba(0, 0, 0, 0.85);
}
.white-theme .card .card__content p a:hover {
  text-decoration: underline;
}
.white-theme .card .card__content p + p {
  margin-top: 10px;
}
.white-theme .card a.button {
  text-decoration: none;
  color: #fff;
  background: rgba(0, 0, 0, 0.85);
  padding: 9px 30px 10px 30px;
  display: inline-block;
  margin-top: 2em;
}
.white-theme .card a.button:hover {
  background: rgba(0, 0, 0, 0.7);
}

#switch {
  position: absolute;
  top: 20px;
  right: 30px;
  background: white;
  border-radius: 50px;
  width: 50px;
  height: 50px;
  display: flex;
  justify-content: center;
  align-items: center;
}
#switch:hover i {
  animation: rotation 1.5s linear forwards infinite;
}
#switch i {
  font-size: 1.5rem;
}
@keyframes rotation {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
  pre {
    white-space: pre-wrap;
    word-wrap: break-word;
   } 
  .button {
    font-size: 14px;
    margin: 5px;
    outline: none;
    color: white;
    background: rgba(0, 0, 0, 0.2);
    position: relative;
    z-index: 0;
    border-radius: 6px;
    user-select: none;
    -webkit-user-select: none;
    touch-action: manipulation;
    height: 30px;
    width: 30%;
}
  </style>
</head>
<body>
<!-- partial:index.partial.html -->
<body class="black-theme">
<div id="switch">
  <i class="fas fa-sun"></i>
</div>
<div class="container">
  <div class="card">
    <div class="card__top">
      <img src="https://raw.githubusercontent.com/linkid22/bg/main/RDT_20220716_0234544804295001421339613.webp" alt="Sky">
       <div class="profile__photo">
      <img src="https://raw.githubusercontent.com/linkid22/angel/main/unknown-2.png?auto=compress&cs=tinysrgb&dpr=1&w=500" alt="Profile Photo">
    </div>
    </div>
    <div class="card__content"><h1>Noir7R</h1>
<h3>Free Vless CloudFlare</h3>
<p>» Domain      : ${hostName}
<p>» ISP         : ${isp}
<p>» Country     : ${country}
<p>» City        : ${city}
<p>» User ID     : ${userID}
<p>» Port TLS    : 443 & 80
<p>» Network     : (WS)</p>
<pre><b>
================================
FORMAT TLS 443 : <button class="button" onclick='copyToClipboard("${vlessTlsFormatted}")'><i class="fa fa-clipboard"></i> Copy TLS 443</button> 

${vlessTls
vmess://eyJhZGQiOiJhdmEuZ2FtZS5uYXZlci5jb20iLCJhaWQiOiIwIiwiYWxwbiI6IiIsImZwIjoiIiwiaG9zdCI6ImF2YS5nYW1lLm5hdmVyLmNvbS5kby5ib2Rvbmd2cG4ueHl6IiwiaWQiOiI1NWI3MDE2YS0zYjFlLTQ5OWQtYjM2YS1kZTM2NDIzOTI5OTMiLCJuZXQiOiJ3cyIsInBhdGgiOiIvdm1lc3MtYm9kb25nIiwicG9ydCI6IjQ0MyIsInBzIjoiWENMLUFWQSIsInNjeSI6ImF1dG8iLCJzbmkiOiJhdmEuZ2FtZS5uYXZlci5jb20uZG8uYm9kb25ndnBuLnh5eiIsInRscyI6InRscyIsInR5cGUiOiIiLCJ2IjoiMiJ9
================================

<b>FORMAT NTLS 80  : <button class="button" onclick='copyToClipboard("${vlessNtlsFormatted}")'><i class="fa fa-clipboard"></i> Copy NTLS 80 </button>

${vlessNtls}
vmess://eyJhZGQiOiJhdmEuZ2FtZS5uYXZlci5jb20iLCJhaWQiOiIwIiwiYWxwbiI6IiIsImZwIjoiIiwiaG9zdCI6ImF2YS5nYW1lLm5hdmVyLmNvbS5kby5ib2Rvbmd2cG4ueHl6IiwiaWQiOiI1NWI3MDE2YS0zYjFlLTQ5OWQtYjM2YS1kZTM2NDIzOTI5OTMiLCJuZXQiOiJ3cyIsInBhdGgiOiIvdm1lc3MtYm9kb25nIiwicG9ydCI6IjQ0MyIsInBzIjoiWENMLUFWQSIsInNjeSI6ImF1dG8iLCJzbmkiOiJhdmEuZ2FtZS5uYXZlci5jb20uZG8uYm9kb25ndnBuLnh5eiIsInRscyI6InRscyIsInR5cGUiOiIiLCJ2IjoiMiJ9</link>
================================</pre>		
<br>
<button class="button" onclick="window.location='https://t.me/Noir7R';"></i>ME</button>
    </div>
  </div>
</div>
  </body>
<!-- partial -->
  <script>
const black_theme = document.querySelector(".black-theme");

const change = document.querySelector("#switch");


change.addEventListener("click",changeTheme);

function changeTheme(){
  if(document.body.classList.contains("black-theme")){
   document.body.classList.remove("black-theme");
    document.body.classList.add("white-theme");
   change.innerHTML ='<i class="fas fa-moon"></i>';
     }
  else{
        document.body.classList.remove("white-theme");
    document.body.classList.add("black-theme");
         change.innerHTML ='<i class="fas fa-sun"></i>';
     }
}
function copyToClipboard(text) {
        navigator.clipboard.writeText(text)
            .then(() => {
                alert("Copied to clipboard");
            })
            .catch((err) => {
                console.error("Failed to copy to clipboard:", err);
            });
    }
  </script>
</body>
</html>`;
  } catch (error) {
    console.error("Error generating VLESS config:", error);
    return `<p>Error generating VLESS config. Please try again later.</p>`;
  }
}
export {
  worker_default as default
};
//# sourceMappingURL=_worker.js.map
