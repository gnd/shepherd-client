import 'unfetch/polyfill/index';
import RFB from '@novnc/novnc/core/rfb';
import Promise from 'promise-polyfill';
import MediaController from "./media-controller";


function toQueryString(obj) {
  var parts = [];
  for (var i in obj) {
    if (obj.hasOwnProperty(i)) {
      parts.push(encodeURIComponent(i) + '=' + encodeURIComponent(obj[i]));
    }
  }
  return parts.join('&');
}


export default function CBrowser(reqid, target_div, init_params) {
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;

  var cmd_port = undefined;
  var vnc_port = undefined;

  var clipEvents = ['paste'];
  var connected = false;
  var countdownTimer = null;
  var visibilityHandle = null;
  var ever_connected = false;
  var fail_count = 0;
  var hasClipboard = false;
  var lastText = undefined;
  var maxRetry = 10;
  var retryCount = 0;
  var retryHandle = null;
  var stagedText = null;
  var timers = []

  var min_width = 300;
  var min_height = 300;

  var rfb;
  var resizeTimeout;
  var vnc_pass = "secret";

  var end_time = undefined;

  var environ = {};
  var audioType = null;

  var targetDivNode = document.querySelector(target_div);

  var waiting_for_container = false;
  var waiting_for_vnc = false;

  init_params = init_params || {};

  init_params.api_prefix = init_params.api_prefix || "";

  var num_vnc_retries = init_params.num_vnc_retries || 3;

  // rfb event callbacks
  var credentialsRequired;
  var connect;
  var disconnect;
  var securityFailure;
  var clipboard
  var rfbEventsBound = false;


  function start() {
    // Countdown updater
    if (init_params.on_countdown) {
      countdownTimer = setInterval(update_countdown, 1000);
    }

    init_html(target_div);

    setup_browser();
  }

  function clipHandler(e) {
    if (!hasClipboard) {
      return false;
    }

    var text;
    if (window.clipboardData && window.clipboardData.getData) { // ie
      text = window.clipboardData.getData('Text');
    } else if (e.clipboardData && e.clipboardData.getData) {
      text = e.clipboardData.getData('text/plain');
    }

    if (connected && rfb && text) {
      rfb.clipboardPasteFrom(text);

      // attempt sending paste command
      rfb.sendKey(0xffe3, null, true);
      rfb.sendKey(0x0076, null, true);
      rfb.sendKey(0x0076, null, false);
      rfb.sendKey(0xffe3, null, false);
    }
  }

  function init_clipboard() {
    if (!init_params.clipboard) {
      return;
    }

    hasClipboard = true;
    lastText = undefined;

    // if remote browser cut/copy opperation occured, insert into clipboard field
    if (stagedText) {
        document.querySelector(init_params.clipboard).value = stagedText;
        stagedText = null;
    }

    for (var i = 0; i < clipEvents.length; i++) {
      document.querySelector(init_params.clipboard).addEventListener(clipEvents[i], clipHandler);
    }
  }

  function destroy_clipboard() {
    if (!init_params.clipboard) {
      return;
    }

    hasClipboard = false;
  }

  function canvas() {
    return targetDivNode.querySelector('.canvas');
  }

  function msgdiv() {
    return targetDivNode.querySelector('#browserMsg');
  }

  function screen() {
    return targetDivNode.querySelector('#noVNC_screen');
  }

  function init_html() {
    // ensure container is emptied of previous browsers
    targetDivNode.innerHTML = '';

    var msgDiv = document.createElement('div');
    msgDiv.setAttribute('id', 'browserMsg');
    msgDiv.setAttribute('class', 'loading');
    targetDivNode.appendChild(msgDiv);

    var canvasEle = document.createElement('div');
    canvasEle.setAttribute('class', 'canvas');
    var canvasDiv = document.createElement('div');
    canvasDiv.setAttribute('id', 'noVNC_screen');
    canvasDiv.appendChild(canvasEle);
    targetDivNode.appendChild(canvasDiv);

    canvasEle.style.display = 'none';
  }

  function setup_browser() {
    if (waiting_for_vnc || waiting_for_container) {
      return;
    }

    var msg;

    if (ever_connected) {
      msg = "Reconnecting to Remote Browser...";
    } else {
      msg = "Initializing Remote Browser...";
    }

    msgdiv().innerHTML = msg;
    msgdiv().style.display = 'block';

    // calculate dimensions
    const bcr = targetDivNode.getBoundingClientRect();
    let w = bcr.width;
    let h = bcr.height;

    if (!init_params.fill_window) {
      w *= 0.96;
      h -= 25;
    }

    if (w < h) {
      // flip mins for vertical layout
      var t = min_width;
      min_width = min_height;
      min_height = t;
    }

    let width = Math.max(w, min_width);
    let height = Math.max(h, min_height);
    width = parseInt(width / 8) * 8;
    height = parseInt(height / 8) * 8;
    //req_params['reqid'] = reqid;

    if (init_params.webrtc) {
      audioType = 'webrtc';
    } else {
      audioType = null;
    }

    if (!audioType) {
      console.log("No Supported Audio Types");
    }

    environ = {'SCREEN_WIDTH': width,
               'SCREEN_HEIGHT': height,
               'AUDIO_TYPE': audioType,
               'REQ_ID': reqid
              };

    init_browser()
  }

  function init_browser() {
    if (waiting_for_container) {
      return;
    }

    waiting_for_container = true;

    //var init_url = init_params.api_prefix + "/init_browser?" + toQueryString(req_params);
    var init_url = init_params.api_prefix + "/api/flock/start/" + reqid;

    var req_params = {"environ": environ};

    var headers = init_params.headers || {};
    headers['Content-Type'] = 'application/json';

    var options = { headers: new Headers(headers),
                    method: "POST",
                    body: JSON.stringify(req_params),
                  };

    if (controller) {
      options.signal = controller.signal;
    }

    // expects json response
    fetch(init_url, options)
      .then(function (res) {
        if (!res.ok) {
          throw new Error(res.status);
        }

        return res.json();
      })
      .then(function (data) {
        waiting_for_container = false;
        handle_browser_response(data);
      })
      .catch(function (err) {
        console.log('fetch error', err);
        waiting_for_container = false;

        // user canceled
        if (err.message === 'AbortError') {
          return;
        }

        if (!err || err.message != 404) {
          msgdiv().innerHTML = 'Reconnecting to Remote Browser...';
          msgdiv().style.display = 'block';

          if (retryCount++ < maxRetry) {
            timers.push(setTimeout(init_browser, 1000));
          }

          return;
        }

        if (init_params.on_event) {
          init_params.on_event('error');
        } else {
          msgdiv().innerHTML = 'Remote Browser Expired... Please try again...';
          msgdiv().style.display = 'block';
        }
      });
  }

  function handle_browser_response(data) {
    
    if (data.containers && data.containers.xserver && data.containers.xserver.ports) {
      let ports = data.containers.xserver.ports;

      vnc_port = ports.vnc_port;
      cmd_port = ports.cmd_port;

      end_time = parseInt(Date.now() / 1000, 10) + data.ttl;

      vnc_pass = data.containers.xserver.environ.VNC_PASS;

      let media_params = {"ports":ports,
        "proxy_ws":init_params.proxy_ws,
        "lock_audio": (init_params.audio == "wait_for_click"),
        "webrtc": init_params.webrtc,
        "webrtc_video": init_params.webrtc_video
      };
      window.mediaController = new MediaController(targetDivNode, media_params);

      if (init_params.audio == "wait_for_click") {
        document.body.addEventListener('click', function () {
          window.mediaController.unlockAudio();
        }, { once: true });

      }

      if (init_params.on_event) {
        init_params.on_event("init", data);
      }

      timers.push(window.setTimeout(try_init_vnc, 3000));

    } else if (data.queue != undefined) {
      var msg = "Waiting for empty slot... ";
      if (data.queue == 0) {
        msg += "<b>You are next!</b>";
      } else {
        msg += "At most <b>" + data.queue + " user(s)</b> ahead of you";
      }
      msgdiv().innerHTML = msg;

      timers.push(window.setTimeout(init_browser, 3000));
    }
  }

  function try_init_vnc() {
    do_vnc()
      .then(function () { waiting_for_vnc = false; })
      .catch(function(err) {
        console.log('failed', err);

        waiting_for_vnc = false;
        fail_count++;

        if (fail_count <= num_vnc_retries) {
          msgdiv().innerHTML = "Retrying to connect to remote browser...";
          timers.push(setTimeout(init_browser, 500));
        } else {
          if (init_params.on_event) {
            init_params.on_event("fail");
          } else {
            msgdiv().innerHTML = "Failed to connect to remote browser... Please try again later";
          }
        }
      })
  }

  function clientPosition() {
    const bcr = targetDivNode.getBoundingClientRect();
    var c = canvas();
    var ch = c.getBoundingClientRect().height;
    var cw = c.getBoundingClientRect().width;
    if (!init_params.fill_window) {
      c.style.marginLeft = ((bcr.width - cw)/2) + 'px';
      c.style.marginTop = ((bcr.height - (ch + 25))/2) + 'px';
    }
  }

  function clientResize() {
    const bcr = targetDivNode.getBoundingClientRect();

    let w = bcr.width;
    let h = bcr.height;

    if (!init_params.fill_window) {
      w = Math.round(w * 0.96);
      h = h - 25;
    }

    if (rfb) {
      var s = rfb._display.autoscale(w, h);
    }
  }

  function onVNCCopyCut(rfb, text) {
    if (init_params.clipboard && hasClipboard) {
      // document.querySelector(init_params.clipboard).innerHTML = (text);
    } else if(init_params.clipboard) {
      stagedText = text;
    }
  }

  function do_vnc() {
    if (waiting_for_vnc) {
      return;
    }

    waiting_for_vnc = true;

    var host = window.location.hostname;
    var port = vnc_port;
    var path = "websockify";
    var protocol = "ws";

    if (window.location.protocol === "https:") {
      protocol = "wss";
    }

    // Proxy WS via the origin host, instead of making direct conn
    // 'proxy_ws' specifies the proxy path, port is appended
    if (init_params.proxy_ws) {
      path = init_params.proxy_ws + port;
      port = window.location.port;
      if (!port) {
        port = (window.location.protocol == "https:" ? 443 : 80);
      }
    }

    var target = canvas();
    var webservice_url = protocol + '://' + host + ':' + port + '/' + path;

    console.log("Connecting to " + webservice_url);

    var promise = new Promise(function (resolve, reject) {
      rfb = new RFB(target, webservice_url, {'credentials': {'password': vnc_pass}});
      window.rfb = rfb;

      //if (!rfbEventsBound) {
      credentialsRequired = function () {
        reject("credentialsrequired");
      }

      connect = function () {
        canvas().style.display = 'block';

        if (init_params.fill_window) {
          canvas().focus();
        }

        msgdiv().style.display = 'none';

        ever_connected = true;
        connected = true;
        fail_count = 0;

        if (init_params.on_event) {
          init_params.on_event("connect");
        }
        rfb.resizeSession = true;
        rfb.scaleViewport = true;

        resolve("connected");
      }

      disconnect = function () {
        connected = false;

        canvas().style.display = 'none';

        var reinit = !document.hidden;

        if (init_params.on_event) {
          init_params.on_event("disconnect");
        }

        if (reinit) {
          setup_browser();
        }
        reject("disconnected");
      }

      securityFailure = function () {
        reject("securityFailure");
      }

      clipboard = function (event) {
        onVNCCopyCut(rfb, event.detail.text);
      }

      rfb.addEventListener("credentialsrequired", credentialsRequired);
      rfb.addEventListener("connect", connect);
      rfb.addEventListener("disconnect", disconnect);
      rfb.addEventListener("securityfailure", securityFailure);
      rfb.addEventListener("clipboard", clipboard);
      //   rfbEventsBound = true;
      // }
    });

    return promise;
  }


  window.onresize = function () {
    // When the window has been resized, wait until the size remains
    // the same for 0.5 seconds before sending the request for changing
    // the resolution of the session
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(function(){
      clientResize();
      //clientPosition();
    }, 500);
  };

  function visibilityChangeCB() {
    if (document.hidden) {
      visibilityHandle = setTimeout(function() {
        if (rfb) {
          rfb.disconnect();
        }
      },
      init_params.inactiveSecs * 1000);
    } else {
      clearTimeout(visibilityHandle);
      if (!connected) {
        if (init_params.on_event) {
          init_params.on_event("reconnect");
        }

        setup_browser();
      }
    }
  }

  function update_countdown() {
    if (!end_time) {
      return;
    }
    var curr = Math.floor(new Date().getTime() / 1000);
    var secdiff = end_time - curr;

    if (secdiff < 0) {
      init_params.on_countdown(0, "00:00");
      return;
    }

    var min = Math.floor(secdiff / 60);
    var sec = secdiff % 60;
    if (sec <= 9) {
      sec = "0" + sec;
    }
    if (min <= 9) {
      min = "0" + min;
    }

    init_params.on_countdown(secdiff, min + ":" + sec);
  }

  if (init_params.inactiveSecs) {
    document.addEventListener("visibilitychange", visibilityChangeCB);
  }

  function clearTimers() {
    // clear intervals and timers
    clearInterval(countdownTimer);
    clearTimeout(visibilityHandle);
    for (var i = 0; i < timers.length; i++) {
      clearTimeout(timers[i]);
    }
    timers = [];
  }

  function close() {
    if (controller) {
      // cancel fetch requests
      controller.abort();
    }

    if (window.mediaController) {
      window.mediaController.stop();
    }

    // stop audio plugin
    if (window.audioPlugin) {
      try {
        console.log("Close Audio");
        window.audioPlugin.close();
        window.audioPlugin = undefined;
      } catch (err){}
    }

    if (rfb) {
      rfb.removeEventListener("credentialsrequired", credentialsRequired);
      rfb.removeEventListener("connect", connect);
      rfb.removeEventListener("disconnect", disconnect);
      rfb.removeEventListener("securityfailure", securityFailure);
      rfb.removeEventListener("clipboard", clipboard);
      rfb.disconnect();
    }

    var cnvs = canvas();
    var _screen = screen();

    clearTimers();

    document.removeEventListener("visibilitychange", visibilityChangeCB);
  }

  start();

  return {
    "close": close,
    "destroy_clipboard": destroy_clipboard,
    "init_clipboard": init_clipboard
   }
}



