// ==UserScript==
// @name               Bilibili B 站浏览助手-改
// @name:zh-CN         Bilibili B 站浏览助手-改
// @name:en            Bilibili Enhancer Tools (Danmaku Edition)
// @description        增强功能：查看封面、下载字幕(SRT/TXT)、下载弹幕(XML/ASS)、下载评论、下载视频(支持 4K/8K)、AI 总结字幕、素材酷平台视频下载、用户空间批量下载、个人收藏批量下载。
// @description:zh-CN  增强功能：查看封面、下载字幕(SRT/TXT)、下载弹幕(XML/ASS)、下载评论、下载视频(支持 4K/8K)、AI 总结字幕、素材酷平台视频下载、用户空间批量下载、个人收藏批量下载。
// @description:en     Enhanced Features: View Cover, Download Subtitles(SRT/TXT), Download Danmaku(XML/ASS), Download Comments, Download Video(4K、8K Support), AI Subtitle Summary, Cool Video Download, User Space Batch Download, Personal Favorites Batch Download.
// @namespace          https://www.runningcheese.com/userscripts
// @author             RunningCheese
// @version            3.9
// @match              http*://www.bilibili.com/video/*
// @match              http*://www.bilibili.com/list/*
// @match              http*://space.bilibili.com/*
// @match              https://cool.bilibili.com/detail/video?*
// @match              https://www.doubao.com/chat/*
// @match              https://chatgpt.com/*
// @match              https://chat.deepseek.com/*
// @match              https://www.qianwen.com/*
// @match              https://gemini.google.com/*
// @icon               https://t1.gstatic.cn/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=32&url=https://www.bilibili.com
// @grant              GM_getValue
// @grant              GM_setValue
// @grant              GM_xmlhttpRequest
// @grant              GM_registerMenuCommand
// @connect            comment.bilibili.com
// @license            MIT
// @downloadURL https://update.greasyfork.org/scripts/588889/Bilibili%20B%20%E7%AB%99%E6%B5%8F%E8%A7%88%E5%8A%A9%E6%89%8B-%E6%94%B9.user.js
// @updateURL https://update.greasyfork.org/scripts/588889/Bilibili%20B%20%E7%AB%99%E6%B5%8F%E8%A7%88%E5%8A%A9%E6%89%8B-%E6%94%B9.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // ═══════════════════════════════════════════
    //  AI 自动填写模块
    // ═══════════════════════════════════════════

    const BILI_PENDING_KEY = 'bili_ai_pending';

    function _sleep(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
    }

    function _waitFor(getter, timeoutMs, intervalMs) {
        var deadline = Date.now() + (timeoutMs || 25000);
        function check() {
            var value = getter();
            if (value) return Promise.resolve(value);
            if (Date.now() >= deadline) return Promise.resolve(null);
            return _sleep(intervalMs || 250).then(check);
        }
        return check();
    }

    function _isVisibleElement(el) {
        if (!el) return false;
        try {
            var style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            var rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        } catch (e) { return false; }
    }

    function _setNativeInputValue(el, value) {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
    }

    // 填入内容（支持 textarea 和 contenteditable）
    function _fillAiInput(input, prompt) {
        // 分别压缩每段，保留段落间的空行
        prompt = prompt.split(/\n{2,}/).map(function(s) {
            return s.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        }).join('\n\n\n');
        input.focus();
        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
            _setNativeInputValue(input, prompt);
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        // contenteditable 元素（用 insertHTML + <br> 确保换行正确渲染）
        input.focus();
        window.getSelection().removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(input);
        window.getSelection().addRange(range);
        var html = prompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
        document.execCommand('insertHTML', false, html);
    }

    // 查找 AI 发送按钮
    function _findAiSendButton() {
        var selectors = [
            '#flow-end-msg-send',
            'button[data-testid="send-button"]',
            'button[aria-label*="Send"]',
            'button[aria-label*="发送"]',
            'form button[type="submit"]'
        ];
        var buttons = [];
        selectors.forEach(function(selector) {
            Array.from(document.querySelectorAll(selector)).forEach(function(btn) { buttons.push(btn); });
        });
        return buttons.find(function(btn) {
            return _isVisibleElement(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !btn.closest('[aria-hidden="true"]');
        }) || null;
    }

    // 平台配置
    var platformInfo = {
        doubao:   { label: '豆包',    url: 'https://www.doubao.com/chat/',     host: 'www.doubao.com' },
        qianwen:  { label: '千问',    url: 'https://www.qianwen.com/',         host: 'www.qianwen.com' },
        deepseek: { label: 'DeepSeek', url: 'https://chat.deepseek.com/',      host: 'chat.deepseek.com' },
        chatgpt:  { label: 'ChatGPT', url: 'https://chatgpt.com/',            host: 'chatgpt.com' },
        gemini:   { label: 'Gemini',  url: 'https://gemini.google.com/',       host: 'gemini.google.com' },
    };

    // 平台专用选择器
    var platformSelectors = {
        doubao: [
            '[data-testid="chat_input_input"]',
            'div[contenteditable="true"][data-testid="chat_input_input"]',
            'div[contenteditable="true"]',
            'textarea[placeholder]'
        ],
        generic: [
            '#prompt-textarea',
            '#chat-input',
            'textarea[placeholder*="Send a message"]',
            'textarea[placeholder*="给"]',
            'textarea[placeholder*="输入"]',
            'textarea[placeholder*="提问"]',
            'div[contenteditable="true"]',
            'textarea[placeholder]'
        ]
    };

    function _findInputBySelectors(selectorList) {
        var candidates = [];
        selectorList.forEach(function(selector) {
            Array.from(document.querySelectorAll(selector)).forEach(function(el) { candidates.push(el); });
        });
        return candidates.find(function(el) { return _isVisibleElement(el) && !el.closest('[aria-hidden="true"]'); }) || null;
    }

    async function _sendPendingToPlatform(platform, prompt) {
        var selectors = platformSelectors[platform] || platformSelectors.generic;
        var input = await _waitFor(function() { return _findInputBySelectors(selectors); }, 30000, 300);
        var info = platformInfo[platform] || { label: platform };
        if (!input) {
            showToast('未找到 ' + info.label + ' 输入框，请手动粘贴', 3000);
            return false;
        }
        _fillAiInput(input, prompt);
        await _sleep(800);
        if (platform === 'deepseek') {
            // DeepSeek 使用回车发送
            input.focus();
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            return true;
        }
        var sendButton = await _waitFor(_findAiSendButton, 10000, 250);
        if (sendButton) {
            sendButton.click();
            return true;
        } else {
            showToast('已填入 Prompt，请手动发送', 2000);
            return false;
        }
    }

    function _readPendingTask() {
        if (typeof GM_getValue !== 'function') return null;
        try {
            var raw = GM_getValue(BILI_PENDING_KEY, '');
            if (!raw) return null;
            var task = JSON.parse(raw);
            if (!task || !task.prompt) return null;
            if (Date.now() - Number(task.createdAt || 0) > 300000) {
                GM_setValue(BILI_PENDING_KEY, '');
                return null;
            }
            return task;
        } catch (err) {
            return null;
        }
    }

    function _clearPendingTask() {
        if (typeof GM_setValue === 'function') {
            GM_setValue(BILI_PENDING_KEY, '');
        }
    }

    function _runAiAdapter() {
        var task = _readPendingTask();
        if (!task) return;
        var platform = task.platform || 'doubao';
        var info = platformInfo[platform] || { label: platform };
        showToast('检测到待发送内容，正在填入 ' + info.label + '...', 2000);
        _sendPendingToPlatform(platform, task.prompt).then(function() {
            _clearPendingTask();
        });
    }

    function setupAiReceiver() {
        setTimeout(_runAiAdapter, 1500);
    }

    // 如果在 AI 平台页面，只运行接收端模式
    var _host = location.hostname.toLowerCase();
    var aiHosts = Object.values(platformInfo).map(function(v) { return v.host; });
    if (aiHosts.indexOf(_host) !== -1 || _host === 'doubao.com') {
        setupAiReceiver();
        return;
    }

    const videoQualities = [
        { id: 127, ext: '.8k.mp4' },
        { id: 126, ext: '.4k.dovi.mp4' },
        { id: 125, ext: '.4k.hdr.mp4' },
        { id: 120, ext: '.4k.mp4' },
        { id: 116, ext: '.1080f60.mp4' },
        { id: 112, ext: '.1080+.mp4' },
        { id: 80, ext: '.1080.mp4' },
        { id: 74, ext: '.720f60.mp4' },
        { id: 64, ext: '.720.mp4' },
        { id: 32, ext: '.480.mp4' },
        { id: 16, ext: '.360.mp4' },
        { id: 15, ext: '.360-.mp4' }
    ];

    const audioQualities = [
        { id: 30280, ext: '.192k.m4a' },
        { id: 30232, ext: '.128k.m4a' },
        { id: 30216, ext: '.64k.m4a' }
    ];

    // 4K/8K 画质 ID（用于下载前询问）
    const HIGH_QUALITY_IDS = [127, 126, 125, 120];

    // 简化的元素创建工具
    const elements = {
        createAs(nodeType, config, appendTo) {
            const element = document.createElement(nodeType);
            if (config) {
                Object.entries(config).forEach(([key, value]) => {
                    element[key] = value;
                });
            }
            if (appendTo) appendTo.appendChild(element);
            return element;
        },
        getAs(selector) {
            return document.body.querySelector(selector);
        }
    };

    // 通用 toast 提示（粉色主题）
    function showToast(msg, duration) {
        duration = duration || 1000;
        var el = document.getElementById('bili-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'bili-toast';
            el.style.cssText = 'position:fixed;top:5%;left:50%;transform:translateX(-50%);background:#3F7FEA;color:#fff;padding:16px 18px;min-height:20px;min-width:180px;line-height:1.2;border-radius:13px;font-size:14px;font-family:sans-serif;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.25s ease;box-shadow:0 2px 8px rgba(0,122,255,0.25),0 0 0 0.5px rgba(0,122,255,0.1);box-sizing:border-box;display:flex;align-items:center;justify-content:center;';
            document.body.appendChild(el);
        }
        clearTimeout(el._timer);
        el.textContent = msg;
        el.style.opacity = '1';
        el._timer = setTimeout(function() {
            el.style.opacity = '0';
        }, duration);
    }

    // SRT 字幕时间格式转换（秒 → hh:mm:ss,ms）
    function fmtSRTTime(t) {
        var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60);
        var s = Math.floor(t % 60), ms = Math.floor((t % 1) * 1000);
        return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s + ',' + (ms < 100 ? '0' : '') + (ms < 10 ? '0' : '') + ms;
    }
    // 将字幕 body 数组转为 SRT 格式文本
    function toSRT(body) {
        return body.map(function(item, i) {
            var text = (item.content || '').split('\n')[0].trim();
            return (i + 1) + '\n' + fmtSRTTime(item.from) + ' --> ' + fmtSRTTime(item.to) + '\n' + text + '\n';
        }).join('\n');
    }

    // ========== 弹幕下载功能（XML / ASS）==========
    // 原理（参考 bilibili高清视频下载1080P 脚本）：
    //   1) 用视频 cid 拼接 https://comment.bilibili.com/{cid}.xml 拿原始弹幕 XML
    //   2) XML 可直接保存，或用 DOMParser 解析后转成 ASS 播放器字幕

    function fetchDanmakuXml(cid) {
        return new Promise(function(resolve, reject) {
            if (!cid) { reject(new Error('缺少 cid，无法获取弹幕')); return; }
            var url = 'https://comment.bilibili.com/' + encodeURIComponent(String(cid)) + '.xml';
            if (typeof GM_xmlhttpRequest !== 'function') {
                fetch(url).then(function(r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.text();
                }).then(resolve, reject);
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET', url: url, responseType: 'text', timeout: 120000,
                onload: function(resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(typeof resp.responseText === 'string' ? resp.responseText : String(resp.response || ''));
                    } else { reject(new Error('弹幕请求失败: HTTP ' + resp.status)); }
                },
                onerror: function() { reject(new Error('弹幕网络请求失败')); },
                ontimeout: function() { reject(new Error('弹幕请求超时')); }
            });
        });
    }

    function assTime(seconds) {
        var v = Math.max(0, Number(seconds) || 0);
        var h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = Math.floor(v % 60);
        var cs = Math.floor((v - Math.floor(v)) * 100);
        var p2 = function(n) { return (n < 10 ? '0' : '') + n; };
        return h + ':' + p2(m) + ':' + p2(s) + '.' + p2(cs);
    }

    function assColor(decimalColor) {
        var v = Math.max(0, Math.min(0xffffff, Number(decimalColor) || 0xffffff));
        var r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
        var h2 = function(n) { return (n < 16 ? '0' : '') + n.toString(16); };
        return '&H00' + h2(b) + h2(g) + h2(r) + '&';
    }

    function assEscapeText(text) {
        return String(text || '')
            .replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
            .replace(/\r?\n/g, '\\N');
    }

    function estimateDanmakuWidth(text, fontSize) {
        var units = 0;
        for (var i = 0; i < String(text || '').length; i++) {
            units += /[\u0000-\u00ff]/.test(String(text).charAt(i)) ? 0.56 : 1;
        }
        return Math.max(fontSize * 2, units * fontSize * 0.98);
    }

    // 将弹幕 XML 转换为 ASS 字幕文本（算法移植自 bilibili高清视频下载1080P）
    function convertDanmakuXmlToAss(xml, title) {
        var doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('弹幕 XML 解析失败');

        var entries = Array.prototype.slice.call(doc.querySelectorAll('d[p]')).map(function(node) {
            var p = String(node.getAttribute('p') || '').split(',');
            return {
                time: Number(p[0]) || 0, mode: Number(p[1]) || 1,
                size: Number(p[2]) || 25, color: Number(p[3]) || 0xffffff,
                text: node.textContent || ''
            };
        }).filter(function(item) { return item.text && item.mode !== 8; })
          .sort(function(a, b) { return a.time - b.time; });

        var width = 1920, height = 1080;
        var scrollDuration = 8, fixedDuration = 4, laneHeight = 54;
        var scrollFree = new Array(17).fill(0);
        var topFree = new Array(7).fill(0);
        var bottomFree = new Array(7).fill(0);

        function pickLane(lanes, start) {
            for (var i = 0; i < lanes.length; i++) {
                if (lanes[i] <= start) return i;
            }
            var best = 0;
            for (var j = 1; j < lanes.length; j++) {
                if (lanes[j] < lanes[best]) best = j;
            }
            return best;
        }

        var events = [];
        entries.forEach(function(entry) {
            var start = entry.time;
            var end = start + scrollDuration;
            var fontSize = Math.max(24, Math.min(64, Math.round(entry.size * 1.75)));
            var tag = '';

            if (entry.mode === 4) {
                var laneB = pickLane(bottomFree, start);
                bottomFree[laneB] = start + fixedDuration;
                end = start + fixedDuration;
                tag = '\\an2\\pos(' + (width / 2) + ',' + (height - 48 - laneB * laneHeight) + ')';
            } else if (entry.mode === 5) {
                var laneT = pickLane(topFree, start);
                topFree[laneT] = start + fixedDuration;
                end = start + fixedDuration;
                tag = '\\an8\\pos(' + (width / 2) + ',' + (48 + laneT * laneHeight) + ')';
            } else if (entry.mode === 7) {
                end = start + fixedDuration;
                tag = '\\an5\\pos(' + (width / 2) + ',' + (height / 2) + ')';
            } else {
                var laneS = pickLane(scrollFree, start);
                scrollFree[laneS] = start + scrollDuration * 0.82;
                var y = 48 + laneS * laneHeight;
                var textWidth = Math.ceil(estimateDanmakuWidth(entry.text, fontSize));
                if (entry.mode === 6) {
                    tag = '\\move(' + (-textWidth - 30) + ',' + y + ',' + (width + 30) + ',' + y + ')';
                } else {
                    tag = '\\move(' + (width + 30) + ',' + y + ',' + (-textWidth - 30) + ',' + y + ')';
                }
            }

            events.push('Dialogue: 0,' + assTime(start) + ',' + assTime(end) +
                ',Danmaku,,0,0,0,,{' + tag + '\\fs' + fontSize + '\\c' + assColor(entry.color) + '}' +
                assEscapeText(entry.text));
        });

        return [
            '[Script Info]',
            'Title: ' + String(title || 'Bilibili Danmaku').replace(/[\r\n]+/g, ' '),
            'ScriptType: v4.00+', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes',
            'PlayResX: ' + width, 'PlayResY: ' + height, '',
            '[V4+ Styles]',
            'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
            'Style: Danmaku,Microsoft YaHei,48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,2,0,7,20,20,20,1',
            '', '[Events]',
            'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
            events.join('\n'), ''
        ].join('\n');
    }

    async function downloadDanmaku(format) {
        var cid = bilibiliViewer.cid;
        if (!cid) {
            var st = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).__INITIAL_STATE__;
            cid = st && st.videoData && st.videoData.cid;
        }
        if (!cid) { showToast('未获取到 cid，请先点击字幕按钮加载视频信息', 3000); return; }
        showToast('正在获取弹幕…', 2000);
        try {
            var xml = await fetchDanmakuXml(cid);
            if (!xml) { showToast('弹幕为空'); return; }
            var safeTitle = document.title.replace(/[\\/:*?"<>|]/g, '_');
            if (format === 'ass') {
                var ass = convertDanmakuXmlToAss(xml, safeTitle);
                var blobAss = new Blob(['\ufeff', ass], { type: 'text/x-ssa;charset=utf-8' });
                var urlAss = URL.createObjectURL(blobAss);
                var aAss = document.createElement('a');
                aAss.href = urlAss; aAss.download = safeTitle + '.ass';
                document.body.appendChild(aAss); aAss.click(); aAss.remove();
                URL.revokeObjectURL(urlAss);
            } else {
                var blobXml = new Blob([xml], { type: 'application/xml;charset=utf-8' });
                var urlXml = URL.createObjectURL(blobXml);
                var aXml = document.createElement('a');
                aXml.href = urlXml; aXml.download = safeTitle + '.xml';
                document.body.appendChild(aXml); aXml.click(); aXml.remove();
                URL.revokeObjectURL(urlXml);
            }
            showToast('弹幕下载完成: ' + (format === 'ass' ? 'ASS' : 'XML'), 2000);
        } catch (err) {
            console.error('[弹幕下载失败]', err);
            showToast('弹幕下载失败: ' + (err && err.message || err), 3000);
        }
    }

    // ========== FFmpeg 音视频合并功能 ==========

    // FFmpeg 相关常量（CDN 地址）
    const FFMPEG_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js';
    const FFMPEG_WASM = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';
    // Bundled worker code derived from @ffmpeg/ffmpeg dist/esm/worker.js (MIT).
    // npx esbuild node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js --bundle --format=esm --platform=browser --minify --outfile=ffmpeg_worker_bundle.js
    const FFMPEG_WORKER_BUNDLE = 'var u="0.12.9",R=`https://unpkg.com/@ffmpeg/core@${u}/dist/umd/ffmpeg-core.js`,s;(function(t){t.LOAD="LOAD",t.EXEC="EXEC",t.FFPROBE="FFPROBE",t.WRITE_FILE="WRITE_FILE",t.READ_FILE="READ_FILE",t.DELETE_FILE="DELETE_FILE",t.RENAME="RENAME",t.CREATE_DIR="CREATE_DIR",t.LIST_DIR="LIST_DIR",t.DELETE_DIR="DELETE_DIR",t.ERROR="ERROR",t.DOWNLOAD="DOWNLOAD",t.PROGRESS="PROGRESS",t.LOG="LOG",t.MOUNT="MOUNT",t.UNMOUNT="UNMOUNT"})(s||(s={}));var a=new Error("unknown message type"),f=new Error("ffmpeg is not loaded, call `await ffmpeg.load()` first"),F=new Error("called FFmpeg.terminate()"),O=new Error("failed to import ffmpeg-core.js");var r,l=async({coreURL:t,wasmURL:o,workerURL:e})=>{let n=!r;try{t||(t=R),importScripts(t)}catch{if((!t||t===R)&&(t=R.replace("/umd/","/esm/")),self.createFFmpegCore=(await import(t)).default,!self.createFFmpegCore)throw O}let E=t,c=o||t.replace(/.js$/g,".wasm"),m=e||t.replace(/.js$/g,".worker.js");return r=await self.createFFmpegCore({mainScriptUrlOrBlob:`${E}#${btoa(JSON.stringify({wasmURL:c,workerURL:m}))}`}),r.setLogger(i=>self.postMessage({type:s.LOG,data:i})),r.setProgress(i=>self.postMessage({type:s.PROGRESS,data:i})),n},D=({args:t,timeout:o=-1})=>{r.setTimeout(o),r.exec(...t);let e=r.ret;return r.reset(),e},I=({args:t,timeout:o=-1})=>{r.setTimeout(o),r.ffprobe(...t);let e=r.ret;return r.reset(),e},S=({path:t,data:o})=>(r.FS.writeFile(t,o),!0),p=({path:t,encoding:o})=>r.FS.readFile(t,{encoding:o}),L=({path:t})=>(r.FS.unlink(t),!0),A=({oldPath:t,newPath:o})=>(r.FS.rename(t,o),!0),N=({path:t})=>(r.FS.mkdir(t),!0),T=({path:t})=>{let o=r.FS.readdir(t),e=[];for(let n of o){let E=r.FS.stat(`${t}/${n}`),c=r.FS.isDir(E.mode);e.push({name:n,isDir:c})}return e},w=({path:t})=>(r.FS.rmdir(t),!0),k=({fsType:t,options:o,mountPoint:e})=>{let n=t,E=r.FS.filesystems[n];return E?(r.FS.mount(E,o,e),!0):!1},_=({mountPoint:t})=>(r.FS.unmount(t),!0);self.onmessage=async({data:{id:t,type:o,data:e}})=>{let n=[],E;try{if(o!==s.LOAD&&!r)throw f;switch(o){case s.LOAD:E=await l(e);break;case s.EXEC:E=D(e);break;case s.FFPROBE:E=I(e);break;case s.WRITE_FILE:E=S(e);break;case s.READ_FILE:E=p(e);break;case s.DELETE_FILE:E=L(e);break;case s.RENAME:E=A(e);break;case s.CREATE_DIR:E=N(e);break;case s.LIST_DIR:E=T(e);break;case s.DELETE_DIR:E=w(e);break;case s.MOUNT:E=k(e);break;case s.UNMOUNT:E=_(e);break;default:throw a}}catch(c){self.postMessage({id:t,type:s.ERROR,data:c.toString()});return}E instanceof Uint8Array&&n.push(E.buffer),self.postMessage({id:t,type:o,data:E},n)};';

    let ffmpegInstance = null;
    let ffmpegInitializing = false;

    // 创建下载进度UI容器（按需创建）
    function createFFmpegProgressUI() {
        let container = document.getElementById('ffmpeg-progress-container');
        if (container) return container;

        container = document.createElement('div');
        container.id = 'ffmpeg-progress-container';
        container.style.cssText = 'position:fixed;top:8%;left:50%;transform:translateX(-50%);z-index:10001;background:white;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.25);padding:12px 16px;min-width:280px;display:none;';
        document.body.appendChild(container);

        const title = document.createElement('div');
        title.id = 'ffmpeg-progress-title';
        title.style.cssText = 'font-size:13px;color:#333;margin-bottom:8px;font-weight:bold;';
        container.appendChild(title);

        const barOuter = document.createElement('div');
        barOuter.style.cssText = 'width:100%;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;';
        container.appendChild(barOuter);

        const barInner = document.createElement('div');
        barInner.id = 'ffmpeg-progress-bar';
        barInner.style.cssText = 'width:0%;height:100%;background:linear-gradient(to right,#fb7299,#ff85a2);border-radius:3px;transition:width 0.3s;';
        barOuter.appendChild(barInner);

        const percent = document.createElement('div');
        percent.id = 'ffmpeg-progress-percent';
        percent.style.cssText = 'font-size:12px;color:#999;margin-top:4px;text-align:right;';
        percent.textContent = '0%';
        container.appendChild(percent);

        return container;
    }

    function updateFFmpegProgress(percent, title) {
        const container = createFFmpegProgressUI();
        container.style.display = 'block';
        const bar = document.getElementById('ffmpeg-progress-bar');
        const pct = document.getElementById('ffmpeg-progress-percent');
        const tit = document.getElementById('ffmpeg-progress-title');
        if (bar) bar.style.width = percent + '%';
        if (pct) pct.textContent = Math.round(percent) + '%';
        if (tit && title) tit.textContent = title;
    }

    function hideFFmpegProgress() {
        const container = document.getElementById('ffmpeg-progress-container');
        if (container) {
            setTimeout(() => { container.style.display = 'none'; }, 1500);
        }
    }

    // 使用 Cache API 缓存 FFmpeg 核心资源
    async function getCached(url, key) {
        const keyPath = '/' + key;
        const CACHE_NAME = 'bilibili-ffmpeg-cache';
        try {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(keyPath);
            if (cached) {
                const ab = await cached.arrayBuffer();
                if (ab.byteLength > 0) return ab;
            }
        } catch(e) { /* Cache API 不可用，跳过缓存 */ }

        const ab = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.response);
                } else {
                    reject(new Error('下载失败: ' + url + ' HTTP ' + xhr.status));
                }
            };
            xhr.onerror = () => reject(new Error('网络错误: ' + url));
            xhr.send();
        });

        try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(keyPath, new Response(ab));
        } catch(e) { /* 缓存写入失败，忽略 */ }

        return ab;
    }

    async function toBlobURL(url, key, mime) {
        const ab = await getCached(url, key);
        if (!(ab instanceof ArrayBuffer) || ab.byteLength === 0) {
            throw new Error('下载失败: ' + url);
        }
        return URL.createObjectURL(new Blob([ab], { type: mime }));
    }

    async function getFFmpeg() {
        if (ffmpegInstance) return ffmpegInstance;
        if (ffmpegInitializing) throw new Error('FFmpeg 正在初始化...');

        ffmpegInitializing = true;
        updateFFmpegProgress(0, '正在加载 FFmpeg ...');

        const { FFmpeg } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/classes.js');
        const ffmpeg = new FFmpeg();

        updateFFmpegProgress(10, '正在下载 FFmpeg Core ...');
        const coreURL = await toBlobURL(FFMPEG_CORE, 'FFMPEG_CORE', 'text/javascript');

        updateFFmpegProgress(40, '正在下载 FFmpeg WASM ...');
        const wasmURL = await toBlobURL(FFMPEG_WASM, 'FFMPEG_WASM', 'application/wasm');

        updateFFmpegProgress(70, '正在初始化 FFmpeg Worker ...');
        const classWorkerURL = URL.createObjectURL(new Blob([FFMPEG_WORKER_BUNDLE], { type: 'text/javascript' }));

        updateFFmpegProgress(85, '正在加载 FFmpeg ...');
        await ffmpeg.load({
            coreURL,
            wasmURL,
            classWorkerURL,
        });

        ffmpegInstance = ffmpeg;
        ffmpegInitializing = false;

        updateFFmpegProgress(100, 'FFmpeg 就绪');
        hideFFmpegProgress();

        return ffmpegInstance;
    }

    // 下载 ArrayBuffer 并支持进度回调
    function downloadArrayBuffer(url, onProgress) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.setRequestHeader('Referer', location.href);
            xhr.onprogress = (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(e.loaded / e.total);
                }
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.response);
                } else {
                    reject(new Error('下载失败: HTTP ' + xhr.status));
                }
            };
            xhr.onerror = () => reject(new Error('网络错误'));
            xhr.send();
        });
    }

    // 合并视频和音频流
    async function mergeVideoAudio(videoUrl, audioUrl) {
        updateFFmpegProgress(0, '正在下载视频和音频流 ...');

        let videoPct = 0, audioPct = 0;

        const [videoBuffer, audioBuffer] = await Promise.all([
            downloadArrayBuffer(videoUrl, (pct) => {
                videoPct = pct;
                updateFFmpegProgress((videoPct + audioPct) * 25, '正在下载视频和音频流 ...');
            }),
            downloadArrayBuffer(audioUrl, (pct) => {
                audioPct = pct;
                updateFFmpegProgress((videoPct + audioPct) * 25, '正在下载视频和音频流 ...');
            })
        ]);

        updateFFmpegProgress(50, '正在初始化 FFmpeg ...');
        const ffmpeg = await getFFmpeg();

        updateFFmpegProgress(50, '正在写入文件 ...');
        const videoName = 'input_video.mp4';
        const audioName = 'input_audio.m4a';
        const outputName = 'output.mp4';

        await ffmpeg.writeFile(videoName, new Uint8Array(videoBuffer));
        updateFFmpegProgress(55, '正在写入视频文件 ...');
        await ffmpeg.writeFile(audioName, new Uint8Array(audioBuffer));
        updateFFmpegProgress(60, '正在合并音视频 ...');

        // 使用 copy 编码，无损且极快
        await ffmpeg.exec(['-i', videoName, '-i', audioName, '-c:v', 'copy', '-c:a', 'copy', outputName]);

        updateFFmpegProgress(90, '正在读取合并结果 ...');
        const data = await ffmpeg.readFile(outputName);

        updateFFmpegProgress(95, '正在清理临时文件 ...');
        await ffmpeg.deleteFile(videoName);
        await ffmpeg.deleteFile(audioName);
        await ffmpeg.deleteFile(outputName);

        updateFFmpegProgress(100, '合并完成！');

        return new Blob([data.buffer], { type: 'video/mp4' });
    }

    // 简化的fetch函数
    function fetch(url, option = {}) {
        return new Promise((resolve, reject) => {
            const req = new XMLHttpRequest();
            req.onreadystatechange = () => {
                if (req.readyState === 4) {
                    resolve({
                        ok: req.status >= 200 && req.status <= 299,
                        status: req.status,
                        statusText: req.statusText,
                        json: () => Promise.resolve(JSON.parse(req.responseText)),
                        text: () => Promise.resolve(req.responseText)
                    });
                }
            };
            if (option.credentials == 'include') req.withCredentials = true;
            req.onerror = reject;
            req.open('GET', url);
            req.send();
        });
    }

    // 创建封面预览容器（含关闭按钮）
    const coverWrap = elements.createAs("div", {
        id: "bili-cover-wrap",
        style: `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 2147483647;
            display: none;
            background: rgba(0,0,0,0.65);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            border-radius: 8px;
            box-shadow: 0 4px 24px rgba(0,0,0,0.5);
            padding: 8px;
            cursor: default;
        `
    });
    // 关闭按钮
    const coverCloseBtn = elements.createAs("div", {
        id: "bili-cover-close",
        style: `
            position: absolute;
            top: -10px;
            right: -10px;
            width: 24px;
            height: 24px;
            background: #fb7299;
            color: #fff;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            cursor: pointer;
            box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            line-height: 1;
            z-index: 1;
        `,
        innerHTML: '&times;',
        onclick: (e) => { e.stopPropagation(); coverWrap.style.display = 'none'; }
    });
    const preview = elements.createAs("img", {
        id: "preview",
        style: `
            max-width: 60vw;
            max-height: 60vh;
            border-radius: 4px;
            display: block;
        `
    }, document.body);

        // 创建字幕显示面板
    const subtitlePanel = elements.createAs("div", {
        id: "subtitle-panel",
        style: `
            position: fixed;
            top: 15%;
            right: 5%;
            transform: translate(-50%, 0);
            width: 300px;
            max-width: 800px;
            max-height: 60vh;
            background: #fff;
            border: none;
            border-radius: 10px;
            padding: 0px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            z-index: 10000;
            display: none;
            flex-direction: column;
            overflow: hidden;
            font-size: 14px;
            color: #333;
            border: 1px solid #ddd;
        `
    }, document.body);

    // 面板右下角缩放手柄
    const panelResizer = elements.createAs("div", {
        style: `position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;z-index:10;`
    }, subtitlePanel);
    let panelResizing = false, panelStartX, panelStartY, panelStartW, panelStartH;
    panelResizer.addEventListener('mousedown', function(e) {
        e.preventDefault(); e.stopPropagation();
        panelResizing = true;
        const rect = subtitlePanel.getBoundingClientRect();
        panelStartX = e.clientX; panelStartY = e.clientY;
        panelStartW = rect.width; panelStartH = rect.height;
        if (subtitlePanel.style.transform !== 'none') {
            subtitlePanel.style.transform = 'none';
            subtitlePanel.style.left = rect.left + 'px';
            subtitlePanel.style.top = rect.top + 'px';
        }
    });
    document.addEventListener('mousemove', function(e) {
        if (!panelResizing) return;
        const dw = e.clientX - panelStartX, dh = e.clientY - panelStartY;
        let newW = panelStartW + dw, newH = panelStartH + dh;
        newW = Math.max(200, Math.min(newW, window.innerWidth - parseInt(subtitlePanel.style.left)));
        newH = Math.max(200, Math.min(newH, window.innerHeight - parseInt(subtitlePanel.style.top)));
        subtitlePanel.style.width = newW + 'px'; subtitlePanel.style.height = newH + 'px';
        subtitlePanel.style.maxWidth = 'none'; subtitlePanel.style.maxHeight = 'none';
    });
    document.addEventListener('mouseup', function() { panelResizing = false; });
    document.addEventListener('mouseleave', function() { panelResizing = false; });

    // 组装封面预览容器
    coverWrap.appendChild(coverCloseBtn);
    coverWrap.appendChild(preview);
    document.body.appendChild(coverWrap);
    // 点击遮罩外区域关闭
    coverWrap.addEventListener('click', function(e) {
        if (e.target === coverWrap) coverWrap.style.display = 'none';
    });
    // 点击页面任意空白处关闭：封面显示时，点击目标不在预览容器内则关闭
    // （封面按钮 onclick 已 stopPropagation，打开/切换不会误触发）
    document.addEventListener('click', function(e) {
        if (coverWrap.style.display !== 'none' && !coverWrap.contains(e.target)) {
            coverWrap.style.display = 'none';
        }
    });
    // 按 Esc 键关闭封面预览
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && coverWrap.style.display !== 'none') {
            coverWrap.style.display = 'none';
        }
    });


    // 创建字幕面板标题栏
    const subtitleHeader = elements.createAs("div", {
        style: `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 7px 10px;
            background: #F1F4F7;
            margin-bottom: 4px;
            cursor: move;
            user-select: none;
            flex-shrink: 0;
        `
    }, subtitlePanel);

    // 添加拖动功能
    let isDragging = false;
    let offsetX, offsetY;

    // 鼠标按下事件（跳过 select 下拉菜单，允许点击选择）
    subtitleHeader.onmousedown = function(e) {
        if (e.target.tagName === 'SELECT') return;
        isDragging = true;

        // 计算鼠标在面板内的相对位置
        const rect = subtitlePanel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;

        // 移除transform属性，使定位更直接
        subtitlePanel.style.transform = 'none';

        // 更新面板位置为当前位置
        subtitlePanel.style.left = rect.left + 'px';
        subtitlePanel.style.top = rect.top + 'px';

        // 防止选中文本
        e.preventDefault();
    };

    // 鼠标移动事件
    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;

        // 计算新位置
        let newLeft = e.clientX - offsetX;
        let newTop = e.clientY - offsetY;

        // 获取面板尺寸
        const rect = subtitlePanel.getBoundingClientRect();

        // 防止面板移出视口
        newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - rect.width));
        newTop = Math.max(0, Math.min(newTop, window.innerHeight - rect.height));

        // 更新位置
        subtitlePanel.style.left = newLeft + 'px';
        subtitlePanel.style.top = newTop + 'px';
    });

    // 鼠标释放事件
    document.addEventListener('mouseup', function() {
        isDragging = false;
    });

    // 鼠标离开窗口事件
    document.addEventListener('mouseleave', function() {
        isDragging = false;
    });

    // 创建字幕语言选择下拉菜单
    const subtitleSelect = elements.createAs("select", {
        id: "subtitle-title",
        style: `font-size:13px;color:#333;border:none;border-radius:4px;cursor:pointer;outline:none;max-width:200px;font-family:inherit;background: transparent;`,
    }, subtitleHeader);
    // 切换语言时重新加载字幕
    subtitleSelect.onchange = function() {
        if (bilibiliViewer.subtitle && bilibiliViewer.subtitle.count > 0) {
            bilibiliViewer._loadSub(this.value);
        }
    };

    // 标题栏右侧（? 关闭符号）
    const headerRight = elements.createAs("div", {
        style: `display: flex; align-items: center; gap: 6px;`
    }, subtitleHeader);

    // ? 关闭符号
    const closeSymbol = elements.createAs("span", {
        textContent: "?",
        style: `cursor:pointer;color:#666;width:20px;height:20px;display:flex;align-items:center;justify-content:center;border-radius:50%;font-size:14px;transition:all 0.2s ease;flex-shrink:0;border:none;background:none;`,
    }, headerRight);
    closeSymbol.onmouseover = function() { this.style.background = '#dadada'; };
    closeSymbol.onmouseout = function() { this.style.background = 'none'; };
    closeSymbol.onclick = function() { subtitlePanel.style.display = 'none'; };

    // 创建字幕内容区域
    const subtitleContent = elements.createAs("div", {
        id: "subtitle-content",
        contentEditable: true,
        style: `padding: 12px; overflow-y: auto; min-height: 190px; line-height: 1.6; white-space: pre-wrap; font-size: 14px; color: #333; flex: 1; outline: none;`
    }, subtitlePanel);
    // 存储原始字幕 body 数据（用于 SRT 导出）
    var _lastSubBody = null;

    // 底部操作栏（两个按钮 space-between 两端对齐）
    const bottomBar = elements.createAs("div", {
        style: `display:flex;padding:8px 4px;flex-shrink:0;justify-content:space-between;`
    }, subtitlePanel);

    // AI 总结预设提示词
    var aiPresets = [
        { text: '1、极简总结', prompt: '请总结以上内容：\n此外，我极度没有耐心，不想动脑子，且有阅读困难。请用最直接的大白话告诉我这段内容到底在讲什么，在能解释清楚的前提下，废话越少越好，禁止使用专业术语。请按以下顺序直接输出：1.【总结】\n直接告诉我核心意思；2.【详细】\n用极简的白话说明来龙去脉；3.【摘录】\n用无序列表列出最重要的几个要点。' },
        { text: '2、要点清单', prompt: '请将以上内容整理成简洁的要点清单，要求：1. 用 markdown 的项目符号格式；2. 每个点都简洁明了；3. 按重要性排序；4. 分类呈现（如适用）；5. 突出关键词或数字。' },
        { text: '3、表格总结', prompt: '请将以上内容的重点提取并整理成 markdown 表格，要求条理清晰，重点突出，易于阅读，表格应当包含以下列：主题、简介。' },
        { text: '4、学习笔记', prompt: '请基于以上内容，生成一份结构清晰的学习笔记，使用 Markdown 格式输出，包括：1.【主题】文章主题与核心论点；2.【大纲】用层级列表展示文章结构；3.【关键字】解释文章中出现的重要概念/术语；4.【金句】3-5条值得记录的金句语录。' },
        { text: '5、孩童解释', prompt: '请用简单易懂的语言解释以上内容，就像向一个五年级学生解释一样，解释要生动有趣，便于理解，但不能有失准确性。要求：1. 使用简单的词汇；2. 多用比喻和类比；3. 避免专业术语；4. 循序渐进地解释。' },
        { text: '6、幽默解释', prompt: '请用轻松幽默的语气总结这段内容，幽默要得体，不失专业性，使用markdown格式。要求：1. 口语化表达；2. 适当使用梗和比喻；3. 保持内容准确性；4. 增加趣味性类比。' },
    ];
    var aiPlatform = 'doubao'; // 当前选择的 AI 平台
    if (typeof GM_getValue === 'function') {
        var saved = GM_getValue('bili_ai_platform', '');
        if (saved) aiPlatform = saved;
    }

    // 创建 AI 总结按钮（带预设提示词下拉）
    const aiWrap = elements.createAs("div", {
        style: `flex:1;margin:0 4px;position:relative;`
    }, bottomBar);
    const aiSummaryBtn = elements.createAs("button", {
        textContent: "AI 总结 ?",
        className: 'sub-btn',
    }, aiWrap);
    // AI 弹出菜单
    function showAIMenu() {
        var old = document.getElementById('ai-menu');
        if (old) { old.remove(); return; }
        var menu = document.createElement('div');
        menu.id = 'ai-menu';
        menu.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;background:#fff;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.2);padding:4px;z-index:999;margin-bottom:4px;';
        aiPresets.forEach(function(p) {
            var opt = document.createElement('div');
            opt.textContent = p.text;
            opt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;';
            opt.onmouseover = function() { this.style.background = '#f0f0f0'; };
            opt.onmouseout = function() { this.style.background = ''; };
            opt.onclick = function(e) {
                e.stopPropagation();
                menu.remove();
                var text = document.getElementById('subtitle-content').textContent;
                var fullPrompt = text + '\n\n' + p.prompt;
                navigator.clipboard.writeText(fullPrompt).then(function() {
                    var info = platformInfo[aiPlatform] || { label: aiPlatform, url: 'https://www.doubao.com/chat/' };
                    showToast('已复制字幕到剪贴板，正在打开 ' + info.label, 2000);
                    if (typeof GM_setValue === 'function') {
                        GM_setValue('bili_ai_pending', JSON.stringify({
                            prompt: fullPrompt,
                            platform: aiPlatform,
                            createdAt: Date.now()
                        }));
                    }
                    setTimeout(function() { window.open(info.url, '_blank'); }, 1000);
                }).catch(function(err) { console.error('复制失败', err); });
            };
            menu.appendChild(opt);
        });
        // 自定义提示词
        var customPrompts = [];
        if (typeof GM_getValue === 'function') {
            try { customPrompts = JSON.parse(GM_getValue('bili_custom_prompts', '[]')); } catch(e) {}
        }
        customPrompts.forEach(function(cp) {
            var opt = document.createElement('div');
            opt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;display:flex;align-items:center;';
            opt.onmouseover = function() { this.style.background = '#f0f0f0'; };
            opt.onmouseout = function() { this.style.background = ''; };
            var label = document.createElement('span');
            label.style.cssText = 'flex:1;';
            label.textContent = cp.text;
            opt.appendChild(label);
            var delBtn = document.createElement('span');
            delBtn.textContent = '?';
            delBtn.style.cssText = 'color:#999;cursor:pointer;padding:0 2px;font-size:12px;flex-shrink:0;';
            delBtn.onmouseover = function() { this.style.color = '#e00'; };
            delBtn.onmouseout = function() { this.style.color = '#999'; };
            delBtn.onclick = function(e) {
                e.stopPropagation();
                menu.remove();
                var idx = customPrompts.indexOf(cp);
                if (idx !== -1) {
                    customPrompts.splice(idx, 1);
                    if (typeof GM_setValue === 'function') {
                        GM_setValue('bili_custom_prompts', JSON.stringify(customPrompts));
                    }
                }
                showToast('已删除提示词', 1000);
                showAIMenu();
            };
            opt.appendChild(delBtn);
            opt.onclick = function(e) {
                e.stopPropagation();
                menu.remove();
                var text = document.getElementById('subtitle-content').textContent;
                var fullPrompt = text + '\n\n' + cp.prompt;
                navigator.clipboard.writeText(fullPrompt).then(function() {
                    var info = platformInfo[aiPlatform] || { label: aiPlatform, url: 'https://www.doubao.com/chat/' };
                    showToast('已复制到剪贴板，正在打开 ' + info.label, 2000);
                    if (typeof GM_setValue === 'function') {
                        GM_setValue('bili_ai_pending', JSON.stringify({
                            prompt: fullPrompt,
                            platform: aiPlatform,
                            createdAt: Date.now()
                        }));
                    }
                    setTimeout(function() { window.open(info.url, '_blank'); }, 1000);
                }).catch(function(err) { console.error('复制失败', err); });
            };
            menu.appendChild(opt);
        });
        // 添加提示词选项
        var addOpt = document.createElement('div');
        addOpt.textContent = '＋ 添加提示词';
        addOpt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;';
        addOpt.onmouseover = function() { this.style.background = '#f0f0f0'; };
        addOpt.onmouseout = function() { this.style.background = ''; };
        addOpt.onclick = function(e) {
            e.stopPropagation();
            menu.remove();
            var label = prompt('请输入提示词名称：');
            if (!label || !label.trim()) return;
            var promptText = prompt('请输入提示词内容：');
            if (!promptText || !promptText.trim()) return;
            if (typeof GM_getValue === 'function') {
                var list = [];
                try { list = JSON.parse(GM_getValue('bili_custom_prompts', '[]')); } catch(e2) {}
                list.push({ text: label.trim(), prompt: promptText.trim() });
                GM_setValue('bili_custom_prompts', JSON.stringify(list));
            }
            showToast('已添加提示词', 1000);
            showAIMenu();
        };
        menu.appendChild(addOpt);
        // 平台下拉选择
        var selectWrap = document.createElement('div');
        selectWrap.style.cssText = 'padding:1px 1px;display:flex;align-items:center;gap:4px;';
        var select = document.createElement('select');
        select.style.cssText = 'flex:1;padding:3px 4px;border:1px solid #ddd;border-radius:4px;font-size:12px;outline:none;cursor:pointer;background:#fff;text-align:center;';
        var platOrder = ['doubao', 'qianwen', 'deepseek', 'chatgpt', 'gemini'];
        platOrder.forEach(function(key) {
            var opt = document.createElement('option');
            opt.value = key;
            opt.textContent = platformInfo[key].label;
            select.appendChild(opt);
        });
        select.value = aiPlatform;
        select.onchange = function(e) {
            e.stopPropagation();
            aiPlatform = select.value;
            if (typeof GM_setValue === 'function') {
                GM_setValue('bili_ai_platform', select.value);
            }
        };
        selectWrap.appendChild(select);
        menu.appendChild(selectWrap);
        aiWrap.appendChild(menu);
        // 阻止菜单内的点击冒泡到 document（修复 Chrome 下 select 点击关闭菜单的问题）
        menu.addEventListener('click', function(e) { e.stopPropagation(); });
    }
    aiSummaryBtn.onclick = function(e) { e.stopPropagation(); showAIMenu(); };

    // 创建下载按钮（带 SRT / TXT 下拉选项）
    const dlWrap = elements.createAs("div", {
        style: `flex:1;margin:0 4px;position:relative;`
    }, bottomBar);
    const downloadBtn = elements.createAs("button", {
        textContent: "下载 ?",
        className: 'sub-btn',
    }, dlWrap);
    // 下载弹出菜单
    function showDLMenu() {
        var old = document.getElementById('dl-menu');
        if (old) { old.remove(); return; }
        var menu = document.createElement('div');
        menu.id = 'dl-menu';
        menu.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;background:#fff;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.2);padding:4px;z-index:999;margin-bottom:4px;';
        // SRT 在前
        var srtOpt = document.createElement('div');
        srtOpt.textContent = 'SRT 字幕';
        srtOpt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;';
        srtOpt.onmouseover = function() { this.style.background = '#f0f0f0'; };
        srtOpt.onmouseout = function() { this.style.background = ''; };
        srtOpt.onclick = function(e) {
            e.stopPropagation();
            menu.remove();
            if (!_lastSubBody) { showToast('暂无字幕数据'); return; }
            var srt = toSRT(_lastSubBody);
            var blob = new Blob([srt], {type: 'text/plain;charset=utf-8'});
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = document.title.replace(/[\\/:*?"<>|]/g, '_') + '.srt';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
        };
        menu.appendChild(srtOpt);
        // TXT 在后
        var txtOpt = document.createElement('div');
        txtOpt.textContent = 'TXT 字幕';
        txtOpt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;';
        txtOpt.onmouseover = function() { this.style.background = '#f0f0f0'; };
        txtOpt.onmouseout = function() { this.style.background = ''; };
        txtOpt.onclick = function(e) {
            e.stopPropagation();
            menu.remove();
            var text = document.getElementById('subtitle-content').textContent;
            var blob = new Blob([text], {type: 'text/plain;charset=utf-8'});
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = document.title.replace(/[\\/:*?"<>|]/g, '_') + '.txt';
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
        };
        menu.appendChild(txtOpt);
        // 弹幕 XML（原始格式）
        var dmXmlOpt = document.createElement('div');
        dmXmlOpt.textContent = '弹幕 XML';
        dmXmlOpt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;border-top:1px solid #eee;';
        dmXmlOpt.onmouseover = function() { this.style.background = '#f0f0f0'; };
        dmXmlOpt.onmouseout = function() { this.style.background = ''; };
        dmXmlOpt.onclick = function(e) {
            e.stopPropagation();
            menu.remove();
            downloadDanmaku('xml');
        };
        menu.appendChild(dmXmlOpt);
        // 弹幕 ASS（播放器字幕）
        var dmAssOpt = document.createElement('div');
        dmAssOpt.textContent = '弹幕 ASS';
        dmAssOpt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;';
        dmAssOpt.onmouseover = function() { this.style.background = '#f0f0f0'; };
        dmAssOpt.onmouseout = function() { this.style.background = ''; };
        dmAssOpt.onclick = function(e) {
            e.stopPropagation();
            menu.remove();
            downloadDanmaku('ass');
        };
        menu.appendChild(dmAssOpt);
        // 提取评论
        var cmtOpt = document.createElement('div');
        cmtOpt.textContent = '提取 评论';
        cmtOpt.style.cssText = 'padding:6px 8px;border-radius:4px;cursor:pointer;font-size:13px;color:#333;';
        cmtOpt.onmouseover = function() { this.style.background = '#f0f0f0'; };
        cmtOpt.onmouseout = function() { this.style.background = ''; };
        cmtOpt.onclick = function(e) {
            e.stopPropagation();
            menu.remove();
            extractComments();
        };
        menu.appendChild(cmtOpt);
        dlWrap.appendChild(menu);
        menu.addEventListener('click', function(e) { e.stopPropagation(); });
    }
    downloadBtn.onclick = function(e) { e.stopPropagation(); showDLMenu(); };

    // 点击页面其他位置关闭所有弹出菜单
    document.addEventListener('click', function() {
        var m = document.getElementById('dl-menu');
        if (m) m.remove();
        m = document.getElementById('ai-menu');
        if (m) m.remove();
    });

    // 添加CSS样式
    const style = elements.createAs('style', {
        textContent: `
            .bili-icon-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 18px;
                height: 18px;
                border-radius: 4px;
                cursor: pointer;
                margin-left: 10px;
                transition: background-color 0.3s, transform 0.2s;
                flex-shrink: 0;
                color: white;
                background-color: #39ADE7;
            }
            .bili-icon-btn:hover {
                background-color: #0088ff;
                transform: scale(1.1);
            }
            .bili-icon-btn svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }
            .bili-icon-btn:hover svg {
                fill: white;
            }

            #subtitle-panel button:hover {
                opacity: 0.9;
            }
            .sub-btn { width:100%; padding:4px 0; border:none; border-radius:6px; cursor:pointer; font-size:13px; color:#333; background:#ededed; transition:background 0.15s; font-family:inherit; text-align:center; }
            .sub-btn:hover { background:#d1d1d6; }
            #subtitle-content::-webkit-scrollbar { width: 10px; }
            #subtitle-content::-webkit-scrollbar-track { background: transparent; }
            #subtitle-content::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }
            #subtitle-content::-webkit-scrollbar-thumb:hover { background: #aaa; }
            #subtitle-content { scrollbar-width: auto; scrollbar-color: #ccc transparent; }
        `
    }, document.head);

    // B站字幕和封面查看器主体
    const bilibiliViewer = {
        window: "undefined" == typeof(unsafeWindow) ? window : unsafeWindow,
        cid: undefined,
        subtitle: undefined,
        pcid: undefined,
        buttonAdded: false,
        buttonCheckInterval: null,

        toast(msg, error) {
            if (error) console.error(msg, error);
            if (!this.toastDiv) {
                this.toastDiv = document.createElement('div');
                this.toastDiv.className = 'bilibili-player-video-toast-item';
            }
            const panel = elements.getAs('.bilibili-player-video-toast-top');
            if (!panel) return;
            clearTimeout(this.removeTimmer);
            this.toastDiv.innerText = msg + (error ? `:${error}` : '');
            panel.appendChild(this.toastDiv);
            this.removeTimmer = setTimeout(() => {
                panel.contains(this.toastDiv) && panel.removeChild(this.toastDiv);
            }, 3000);
        },

        getSubtitle(lan, name) {
            const item = this.getSubtitleInfo(lan, name);
            if (!item) throw('找不到所选语言字幕' + lan);

            return fetch(item.subtitle_url)
                .then(res => res.json());
        },

        getSubtitleInfo(lan, name) {
            return this.subtitle.subtitles.find(item => item.lan == lan || item.lan_doc == name);
        },

        getInfo(name) {
            return this.window[name]
            || this.window.__INITIAL_STATE__ && this.window.__INITIAL_STATE__[name]
            || this.window.__INITIAL_STATE__ && this.window.__INITIAL_STATE__.epInfo && this.window.__INITIAL_STATE__.epInfo[name]
            || this.window.__INITIAL_STATE__ && this.window.__INITIAL_STATE__.videoData && this.window.__INITIAL_STATE__.videoData[name];
        },

        getEpid() {
            return this.getInfo('id')
            || /ep(\d+)/.test(location.pathname) && +RegExp.$1
            || /ss\d+/.test(location.pathname);
        },

        getEpInfo() {
            const bvid = this.getInfo('bvid'),
                  epid = this.getEpid(),
                  cidMap = this.getInfo('cidMap'),
                  page = this?.window?.__INITIAL_STATE__?.p;
            let ep = cidMap?.[bvid];
            if (ep) {
                this.aid = ep.aid;
                this.bvid = ep.bvid;
                this.cid = ep.cids[page];
                return this.cid;
            }
            ep = this.window.__NEXT_DATA__?.props?.pageProps?.dehydratedState?.queries
            ?.find(query => query?.queryKey?.[0] == "pgc/view/web/season")
            ?.state?.data;
            ep = (ep?.seasonInfo ?? ep)?.mediaInfo?.episodes
            ?.find(ep => epid == true || ep.ep_id == epid);
            if (ep) {
                this.epid = ep.ep_id;
                this.cid = ep.cid;
                this.aid = ep.aid;
                this.bvid = ep.bvid;
                return this.cid;
            }
            ep = this.window.__INITIAL_STATE__?.epInfo;
            if (ep) {
                this.epid = ep.id;
                this.cid = ep.cid;
                this.aid = ep.aid;
                this.bvid = ep.bvid;
                return this.cid;
            }
            ep = this.window.playerRaw?.getManifest();
            if (ep) {
                this.epid = ep.episodeId;
                this.cid = ep.cid;
                this.aid = ep.aid;
                this.bvid = ep.bvid;
                return this.cid;
            }
        },

        async setupData() {
            if (this.subtitle && (this.pcid == this.getEpInfo())) return this.subtitle;

            if (location.pathname == '/blackboard/html5player.html') {
                let match = location.search.match(/cid=(\d+)/i);
                if (!match) return;
                this.window.cid = match[1];
                match = location.search.match(/aid=(\d+)/i);
                if (match) this.window.aid = match[1];
                match = location.search.match(/bvid=(\d+)/i);
                if (match) this.window.bvid = match[1];
            }

            this.pcid = this.getEpInfo();
            if ((!this.cid && !this.epid) || (!this.aid && !this.bvid)) return;

            this.player = this.window.player;
            this.subtitle = {count: 0, subtitles: []};

            return fetch(`https://api.bilibili.com/x/player${this.cid ? '/wbi' : ''}/v2?${this.cid ? `cid=${this.cid}` : `&ep_id=${this.epid}`}${this.aid ? `&aid=${this.aid}` : `&bvid=${this.bvid}`}`, {credentials: 'include'}).then(res => {
                if (res.status == 200) {
                    return res.json().then(ret => {
                        if (ret.code == -404) {
                            return fetch(`//api.bilibili.com/x/v2/dm/view?${this.aid ? `aid=${this.aid}` : `bvid=${this.bvid}`}&oid=${this.cid}&type=1`, {credentials: 'include'}).then(res => {
                                return res.json();
                            }).then(ret => {
                                if (ret.code != 0) throw('无法读取本视频APP字幕配置' + ret.message);
                                this.subtitle = ret.data && ret.data.subtitle || {subtitles: []};
                                this.subtitle.count = this.subtitle.subtitles.length;
                                this.subtitle.subtitles.forEach(item => (item.subtitle_url = item.subtitle_url.replace(/https?:\/\//, '//')));
                                return this.subtitle;
                            });
                        }
                        if (ret.code != 0 || !ret.data || !ret.data.subtitle) throw('读取视频字幕配置错误:' + ret.code + ret.message);
                        this.subtitle = ret.data.subtitle;
                        this.subtitle.count = this.subtitle.subtitles.length;
                        return this.subtitle;
                    });
                } else {
                    throw('请求字幕配置失败:' + res.statusText);
                }
            });
        },

        // 获取B站视频封面URL
        getBiliCoverUrl() {
            try {
                // 尝试从meta标签获取封面
                const metaImage = document.querySelector('meta[itemprop=image]');
                if (metaImage) {
                    return metaImage.content.replace(/@100w_100h_1c.png/g, '');
                }

                // 尝试其他方法获取封面
                const ogImage = document.querySelector('meta[property="og:image"]');
                if (ogImage) {
                    return ogImage.content.replace(/@100w_100h_1c.png/g, '');
                }

                // 尝试从视频页面获取封面
                const videoInfo = this.window.__INITIAL_STATE__?.videoData;
                if (videoInfo && videoInfo.pic) {
                    return videoInfo.pic;
                }

                return null;
            } catch (error) {
                console.error('获取B站封面出错:', error);
                return null;
            }
        },

        // 添加字幕和封面按钮到固定浮窗（跟踪 .video-info-detail-list 位置）
        addButtons() {
            // 如果按钮已添加，则不重复添加
            if (elements.getAs('#subtitle-viewer-btn') && elements.getAs('#cover-viewer-btn') && elements.getAs('#download-video-btn')) {
                return;
            }

            // 创建固定浮窗容器，挂在 document.body 下，不碰 Vue 管辖元素
            let floatBar = document.getElementById('bili-viewer-floatbar');
            if (!floatBar) {
                floatBar = document.createElement('div');
                floatBar.id = 'bili-viewer-floatbar';
                floatBar.style.cssText = 'position: fixed; z-index: 9999; display: none; align-items: center; gap: 6px;';
                document.body.appendChild(floatBar);
            }

            // 创建封面按钮
            if (!elements.getAs('#cover-viewer-btn')) {
                const coverBtn = elements.createAs('a', {
                    id: 'cover-viewer-btn',
                    className: 'bili-icon-btn',
                    title: '查看视频封面（点击显示/隐藏）\n右键：新标签页打开',
                    innerHTML: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/><path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/></svg>',
                    onclick: (e) => { e.stopPropagation(); this.toggleCoverPreview(e); },
                    oncontextmenu: (e) => { e.preventDefault(); this.openCoverInNewTab(); }
                }, floatBar);
            }

            // 创建字幕按钮
            if (!elements.getAs('#subtitle-viewer-btn')) {
                const subtitleBtn = elements.createAs('a', {
                    id: 'subtitle-viewer-btn',
                    className: 'bili-icon-btn',
                    title: '获取视频字幕',
                    innerHTML: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.5a1 1 0 0 0-.8.4l-1.9 2.533a1 1 0 0 1-1.6 0L5.3 12.4a1 1 0 0 0-.8-.4H2a2 2 0 0 1-2-2V2zm7.194 2.766a1.688 1.688 0 0 0-.227-.272 1.467 1.467 0 0 0-.469-.324l-.008-.004A1.785 1.785 0 0 0 5.734 4C4.776 4 4 4.746 4 5.667c0 .92.776 1.666 1.734 1.666.343 0 .662-.095.931-.26-.137.389-.39.804-.81 1.22a.405.405 0 0 0 .011.59c.173.16.447.155.614-.01 1.334-1.329 1.37-2.758.941-3.706a2.461 2.461 0 0 0-.227-.4zM11 7.073c-.136.389-.39.804-.81 1.22a.405.405 0 0 0 .012.59c.172.16.446.155.613-.01 1.334-1.329 1.37-2.758.942-3.706a2.466 2.466 0 0 0-.228-.4 1.686 1.686 0 0 0-.227-.273 1.466 1.466 0 0 0-.469-.324l-.008-.004A1.785 1.785 0 0 0 10.07 4c-.957 0-1.734.746-1.734 1.667 0 .92.777 1.666 1.734 1.666.343 0 .662-.095.931-.26z"/></svg>',
                    onclick: () => this.showSubtitleInPanel()
                }, floatBar);
            }

            // 创建下载视频按钮
            if (!elements.getAs('#download-video-btn')) {
                const downloadBtn = elements.createAs('a', {
                    id: 'download-video-btn',
                    className: 'bili-icon-btn',
                    title: '下载视频\n左键：原生 API 下载\n右键：第三方网站下载',
                    innerHTML: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 14 14"><path fill-rule="evenodd" d="M7 14A7 7 0 1 0 7 0a7 7 0 0 0 0 14m3.146-5.69l-2.793 2.793a.5.5 0 0 1-.707 0L3.854 8.31a.5.5 0 0 1 .353-.853H6V3.75a1 1 0 0 1 2 0v3.707h1.793a.5.5 0 0 1 .353.853" clip-rule="evenodd"/></svg>',
                    onclick: () => {
                        this.biliVideoDownload();
                    },
                    oncontextmenu: (e) => {
                        e.preventDefault();
                        const videoUrl = window.location.href;
                        navigator.clipboard.writeText(videoUrl).then(() => {
                            this.toast('视频地址已复制，正在打开下载页');

                            showToast('已复制视频地址，正在打开下载页面!', 2000);

                            setTimeout(() => {
                                window.open('https://snapwc.com/zh', '_blank');
                            }, 500);
                        }).catch(err => {
                            console.error('复制视频地址失败', err);
                            window.open('https://snapwc.com/zh', '_blank');
                        });
                    }
                }, floatBar);
            }

            this.buttonAdded = true;
            this.startFloatBarTracking();
            console.log('B站字幕、封面查看和下载按钮已添加到浮动浮窗（跟踪详情行位置）');
        },

        // 启动浮动浮窗位置跟踪，跟随 .video-info-detail-list 末尾
        startFloatBarTracking() {
            let lastUrl = location.href;
            let rafId = null;

            const update = () => {
                const floatBar = document.getElementById('bili-viewer-floatbar');
                if (!floatBar) {
                    rafId = requestAnimationFrame(update);
                    return;
                }

                // SPA 路由变化时停止旧跟踪（addButtons 会重新启动）
                if (location.href !== lastUrl) {
                    if (rafId) cancelAnimationFrame(rafId);
                    floatBar.style.display = 'none';
                    return;
                }

                const detailList = document.querySelector('.video-info-detail-list.video-info-detail-content');
                if (!detailList) {
                    floatBar.style.display = 'none';
                    rafId = requestAnimationFrame(update);
                    return;
                }

                const rect = detailList.getBoundingClientRect();

                // 目标在视口内才显示
                if (rect.bottom < 0 || rect.top > window.innerHeight) {
                    floatBar.style.display = 'none';
                    rafId = requestAnimationFrame(update);
                    return;
                }

                // 定位到详情行右侧，垂直居中对齐
                floatBar.style.display = 'flex';
                floatBar.style.left = (rect.right - floatBar.offsetWidth) + 'px';
                floatBar.style.top = (rect.top + (rect.height - floatBar.offsetHeight) / 2) + 'px';

                rafId = requestAnimationFrame(update);
            };

            rafId = requestAnimationFrame(update);
        },

           // 在面板中显示字幕
         showSubtitleInPanel() {
    // 始终显示面板
    subtitlePanel.style.display = 'flex';

    const select = document.getElementById('subtitle-title');
    const prevValue = select.value;

    // 填充下拉选项
    select.innerHTML = '';
    if (!this.subtitle || this.subtitle.count === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '无字幕';
        select.appendChild(opt);
        subtitleContent.textContent = '当前无字幕，但可提取评论...';
        return;
    }
    this.subtitle.subtitles.forEach(sub => {
        const opt = document.createElement('option');
        opt.value = sub.lan;
        opt.textContent = '▼ ' + (sub.lan_doc || sub.lan);
        select.appendChild(opt);
    });

    // 自动选择：简体中文 > 繁体中文 > 其他中文 > 上次选中 > 第一个
    const preferred = this.subtitle.subtitles.find(sub =>
        sub.lan === 'zh-CN' || sub.lan === 'zh-Hans' ||
        sub.lan_doc?.includes('中文（简体）') || sub.lan_doc?.includes('中文(简体)') ||
        sub.lan_doc === '中文'
    ) || this.subtitle.subtitles.find(sub =>
        sub.lan === 'zh-TW' || sub.lan === 'zh-Hant' ||
        sub.lan_doc?.includes('中文（繁體）') || sub.lan_doc?.includes('中文(繁體)') ||
        sub.lan_doc?.includes('中文（繁体）') || sub.lan_doc?.includes('中文(繁体)')
    ) || this.subtitle.subtitles.find(sub =>
        sub.lan?.toLowerCase().startsWith('zh') || sub.lan_doc?.includes('中文')
    );

    if (preferred && this.subtitle.subtitles.some(s => s.lan === preferred.lan)) {
        select.value = preferred.lan;
    } else if (prevValue && this.subtitle.subtitles.some(s => s.lan === prevValue)) {
        select.value = prevValue;
    } else {
        select.value = this.subtitle.subtitles[0].lan;
    }

    // 加载选中语言的字幕
    this._loadSub(select.value);
      },

      // 加载指定语言的字幕
      _loadSub(lan) {
    subtitleContent.textContent = '正在加载字幕...';

    this.getSubtitle(lan)
        .then(data => {
            if (!data || !(data.body instanceof Array)) {
                throw '数据错误';
            }
            // 存储原始数据供 SRT 导出
            _lastSubBody = data.body;
            // 取 content 第一行（B站双语字幕原语种 + 中文用 \n 分隔）
            const formattedSubtitle = data.body.map(item => (item.content || '').split('\n')[0].trim() + '，').join('\r\n');
            subtitleContent.textContent = formattedSubtitle;
        })
        .catch(e => {
            subtitleContent.textContent = `获取字幕失败: ${e}`;
            this.toast('获取字幕失败', e);
            setTimeout(() => {
                subtitlePanel.style.display = 'none';
            }, 2000);
        });
      },

        // 格式化时间为 mm:ss.ms 格式
        formatTime(seconds) {
            const min = Math.floor(seconds / 60);
            const sec = Math.floor(seconds % 60);
            const ms = Math.floor((seconds % 1) * 100);
            return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
        },

        // 切换显示封面预览（点击触发）
        toggleCoverPreview(event) {
            if (coverWrap.style.display !== 'none') {
                coverWrap.style.display = 'none';
                return;
            }
            const coverUrl = this.getBiliCoverUrl();
            if (coverUrl) {
                preview.src = coverUrl;
                coverWrap.style.display = 'block';
            } else {
                this.toast('未找到封面图片');
            }
        },

        // 在新标签页打开封面
        openCoverInNewTab() {
            const coverUrl = this.getBiliCoverUrl();
            if (coverUrl) {
                window.open(coverUrl, '_blank');
            } else {
                this.toast('无法获取视频封面');
            }
        },

        // 使用原生 API 下载视频（自动合并音视频）
        async biliVideoDownload() {
            if (this._downloading) {
                this.toast('下载正在进行中，请稍候');
                return;
            }

            this.getEpInfo();

            if (!this.cid && !this.epid) {
                this.toast('无法获取视频信息');
                return;
            }

            this._downloading = true;
            this.toast('正在获取下载信息...');

            try {
                let playurl, title, dataKey;

                if (location.pathname.startsWith('/video/')) {
                    const videoData = this.window.__INITIAL_STATE__?.videoData;
                    title = videoData?.title || document.title;
                    playurl = `x/player/playurl?avid=${this.aid}&cid=${this.cid}`;
                    dataKey = 'data';
                    const multi = document.querySelector('li.bpx-state-multi-active-item')?.textContent?.trim();
                    if (multi) title = `${title}-${multi}`;
                } else if (this.epid) {
                    title = document.querySelector('.media-title')?.textContent?.trim()
                         || document.querySelector('.video-title')?.textContent?.trim()
                         || document.title;
                    playurl = `pgc/player/web/playurl?ep_id=${this.epid}`;
                    dataKey = 'result';
                } else {
                    this.toast('无法识别视频类型');
                    return;
                }

                const safeTitle = title.replace(/[/\\:*?"<>|\s]/g, '_');

                const response = await fetch('https://api.bilibili.com/' + playurl + '&fnval=4050&fourk=1', { credentials: 'include' });
                const json = await response.json();
                const { video, audio } = json[dataKey]?.dash ?? { video: [], audio: [] };

                if (!video.length && !audio.length) {
                    this.toast('未获取到视频流信息，可能需要登录');
                    return;
                }

                const videoIds = new Set(video.map(v => v.id));
                const audioIds = new Set(audio.map(a => a.id));

                // 询问是否下载 4K/8K 高清画质
                const hasHighQuality = video.some(v => HIGH_QUALITY_IDS.includes(v.id));
                let qualitiesToUse = videoQualities;
                if (hasHighQuality) {
                    if (!confirm('检测到该视频支持 4K/8K 超高清画质，是否下载？\n\n确定 → 下载最高画质\n取消 → 下载 1080P 画质')) {
                        qualitiesToUse = videoQualities.filter(q => !HIGH_QUALITY_IDS.includes(q.id));
                    }
                }

                const pickedVideo = qualitiesToUse.find(q => videoIds.has(q.id));
                const pickedAudio = audioQualities.find(q => audioIds.has(q.id));

                if (pickedVideo && pickedAudio) {
                    // 同时有视频和音频流，使用 FFmpeg 合并下载
                    const videoItem = video.find(v => v.id === pickedVideo.id);
                    const audioItem = audio.find(a => a.id === pickedAudio.id);
                    this.toast('正在合并下载: 视频' + pickedVideo.ext + ' + 音频' + pickedAudio.ext);

                    try {
                        const mergedBlob = await mergeVideoAudio(videoItem.baseUrl, audioItem.baseUrl);
                        this._downloadBlob(mergedBlob, safeTitle + '.mp4');
                        hideFFmpegProgress();
                        this.toast('合并下载完成！');
                    } catch (mergeErr) {
                        console.error('合并失败，回退到分别下载', mergeErr);
                        hideFFmpegProgress();
                        this.toast('合并失败，改为分别下载视频和音频');
                        this._downloadFile(videoItem.baseUrl, safeTitle + pickedVideo.ext);
                        this._downloadFile(audioItem.baseUrl, safeTitle + pickedAudio.ext);
                    }
                } else if (pickedVideo) {
                    const item = video.find(v => v.id === pickedVideo.id);
                    this.toast('正在下载视频 ' + pickedVideo.ext);
                    this._downloadFile(item.baseUrl, safeTitle + pickedVideo.ext);
                } else if (pickedAudio) {
                    const item = audio.find(a => a.id === pickedAudio.id);
                    this.toast('正在下载音频 ' + pickedAudio.ext);
                    this._downloadFile(item.baseUrl, safeTitle + pickedAudio.ext);
                }

                if (!pickedVideo && !pickedAudio) {
                    this.toast('未找到合适的视频/音频格式');
                }
            } catch (e) {
                this.toast('下载失败', e);
                hideFFmpegProgress();
            } finally {
                this._downloading = false;
            }
        },

        _downloadFile(url, filename) {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'blob';
            xhr.setRequestHeader('Referer', location.href);
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    const blob = xhr.response;
                    const a = document.createElement('a');
                    const blobUrl = URL.createObjectURL(blob);
                    a.href = blobUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
                } else {
                    this.toast('文件下载失败，状态码: ' + xhr.status);
                }
            };
            xhr.onerror = () => {
                this.toast('文件下载失败，网络错误');
            };
            xhr.send();
        },

        _downloadBlob(blob, filename) {
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        },

        // 重置状态，用于页面切换时
        reset() {
            this.buttonAdded = false;
            this.subtitle = null;
            this.pcid = null;

            // 清除定时检查
            if (this.buttonCheckInterval) {
                clearInterval(this.buttonCheckInterval);
                this.buttonCheckInterval = null;
            }
        },

        // 启动定时检查按钮是否存在
        startButtonCheck() {
            // 清除可能存在的旧定时器
            if (this.buttonCheckInterval) {
                clearInterval(this.buttonCheckInterval);
            }

            // 每2秒检查一次按钮是否存在
            this.buttonCheckInterval = setInterval(() => {
                if (!elements.getAs('#subtitle-viewer-btn') || !elements.getAs('#cover-viewer-btn') || !elements.getAs('#download-video-btn')) {
                    console.log('按钮已消失，重新添加');
                    this.buttonAdded = false;
                    this.addButtons();
                }
            }, 2000);
        },

        init() {
            // 第一时间添加按钮（不等待 API 请求）
            const tryAddButtons = () => {
                if (!elements.getAs('#subtitle-viewer-btn') || !elements.getAs('#cover-viewer-btn') || !elements.getAs('#download-video-btn')) {
                    this.addButtons();
                }
            };
            tryAddButtons();

            // DOM 未就绪时等待 DOMContentLoaded
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', tryAddButtons);
            }

            // 后台获取字幕等数据（不影响按钮显示）
            this.setupData().then(subtitle => {
                if (!subtitle) return;
                tryAddButtons();
                this.startButtonCheck();
                console.log('B站字幕和封面查看器初始化成功');
            }).catch(e => {
                console.error('B站字幕和封面查看器初始化失败', e);
            });

            // 持续监听 DOM 变化，确保按钮第一时间出现（参考 Onekey.js 方案）
            let addPending = false;
            let lastUrl = location.href;
            new MutationObserver(() => {
                // 检测 SPA 页面跳转
                if (lastUrl !== location.href) {
                    lastUrl = location.href;
                    this.reset();
                    setTimeout(() => {
                        tryAddButtons();
                        this.startButtonCheck();
                    }, 1000);
                    return;
                }
                // 按钮不存在时尝试添加（rAF 防抖）
                if (!elements.getAs('#subtitle-viewer-btn') || !elements.getAs('#cover-viewer-btn') || !elements.getAs('#download-video-btn')) {
                    if (addPending) return;
                    addPending = true;
                    requestAnimationFrame(() => {
                        tryAddButtons();
                        addPending = false;
                    });
                }
            }).observe(document.body, {
                childList: true,
                subtree: true,
            });
        }
    };

    // 初始化
    bilibiliViewer.init();

    // ═══════════════════════════════════════════
    //  Module: B站用户空间 - 批量下载视频
    // ═══════════════════════════════════════════

    if (location.hostname === 'space.bilibili.com') {
        (function() {
            const S = {
                uid: '',
                videos: new Map(),
                downloading: false,
                enabled: false,
                useHighQuality: false,
            };

            // ── helpers ──
            const pj = (txt) => { try { return JSON.parse(txt); } catch (_) { return null; } };
            const sf = (v, fb, ml) => { const c = String(v || fb).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, ml || 80); return c || fb; };

            const fv = (item) => ({
                bvid: item.bvid || item.bv_id || '',
                aid: item.aid || item.id || 0,
                title: item.title || '未命名',
                pic: item.pic || item.cover || '',
                author: item.author || (item.upper && item.upper.name) || '',
                mid: item.mid || (item.upper && item.upper.mid) || 0,
                length: item.length || item.duration || '',
            });

            // ── toast ──
            let _t = null;
            const tst = (msg, sticky) => {
                let el = document.getElementById('bili-toast');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'bili-toast';
                    el.style.cssText = 'position:fixed;top:5%;left:50%;transform:translateX(-50%);background:#fb7299;color:#fff;padding:16px 18px;min-height:20px;min-width:180px;line-height:1.2;border-radius:13px;font-size:14px;font-family:sans-serif;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 0.25s ease;box-shadow:0 2px 8px rgba(251,114,153,0.25),0 0 0 0.5px rgba(251,114,153,0.1);box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;';
                    document.body.appendChild(el);
                }
                clearTimeout(_t);
                el.textContent = msg;
                el.style.opacity = '1';
                if (!sticky) { _t = setTimeout(() => { el.style.opacity = '0'; }, 2000); }
            };

            // ── network hooks ──
            const API_PATTERNS = [
                '/x/space/wbi/arc/search',
                '/x/space/acc/info',
                '/seasons_series_archivelist',
                '/seasons_archives_list',
                '/seasons_series',
                '/fav/resource/list',
            ];

            const su = (url) => {
                if (!url || typeof url !== 'string') return false;
                return API_PATTERNS.some(p => url.includes(p));
            };

            const ha = (url, txt) => {
                if (!su(url)) return;
                const d = pj(txt);
                if (!d || d.code !== 0) return;

                const add = (items) => {
                    if (!Array.isArray(items)) return;
                    items.map(fv).forEach(v => {
                        if (v.bvid) S.videos.set(v.bvid, v);
                    });
                    rv();
                };

                if (url.includes('/x/space/acc/info')) {
                    const info = d.data;
                    if (info && info.mid) S.uid = String(info.mid);
                } else if (url.includes('/seasons_series_archivelist')) {
                    // 系列视频详情: data.archives[]
                    add(d.data?.archives);
                } else if (url.includes('/seasons_archives_list')) {
                    // 合集视频页: data.archives[]
                    add(d.data?.archives);
                } else if (url.includes('/seasons_series')) {
                    // 系列总览: data.items_lists.series_list[].archives[]
                    const seriesList = d.data?.items_lists?.series_list;
                    if (Array.isArray(seriesList)) {
                        seriesList.forEach(s => add(s.archives));
                    }
                } else if (url.includes('/fav/resource/list')) {
                    // 收藏夹: data.medias[] (过滤 type=2 的视频)
                    const medias = d.data?.medias;
                    if (Array.isArray(medias)) {
                        add(medias.filter(m => m.type === 2));
                    }
                } else {
                    // 用户空间视频搜索: data.list.vlist[]
                    add(d.data?.list?.vlist);
                }
            };

            // Hook XHR
            const hx = () => {
                const _o = XMLHttpRequest.prototype.open;
                const _s = XMLHttpRequest.prototype.send;
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._u = String(url || '');
                    return _o.apply(this, arguments);
                };
                XMLHttpRequest.prototype.send = function(body) {
                    this.addEventListener('load', function() {
                        try { ha(this._u || '', this.responseText || ''); } catch (_) {}
                    });
                    return _s.apply(this, arguments);
                };
            };

            // Hook fetch
            const hf = () => {
                if (typeof window.fetch !== 'function') return;
                const _f = window.fetch;
                window.fetch = async function(...args) {
                    const r = await _f.apply(this, args);
                    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
                    if (su(url)) {
                        r.clone().text().then((t) => ha(url, t)).catch(() => {});
                    }
                    return r;
                };
            };

            // ── download helpers ──

            // Get video CID from bvid
            const getCid = async (bvid) => {
                const resp = await fetch(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`, { credentials: 'include' });
                const json = await resp.json();
                if (json.code !== 0 || !json.data || !json.data.length) {
                    throw new Error('获取视频分P信息失败');
                }
                return json.data[0].cid;
            };

            // Get download URLs for a video
            const getPlayUrl = async (v, cid) => {
                let url = `https://api.bilibili.com/x/player/playurl?cid=${cid}&fnval=4050&fnver=0&fourk=1`;
                if (v.aid) url += `&avid=${v.aid}`;
                if (v.bvid) url += `&bvid=${v.bvid}`;
                const resp = await fetch(url, { credentials: 'include' });
                const json = await resp.json();
                if (json.code !== 0) {
                    throw new Error('获取播放地址失败: ' + (json.message || json.code));
                }
                const dash = json.data?.dash;
                if (!dash || (!dash.video?.length && !dash.audio?.length)) {
                    throw new Error('该视频无DASH格式，可能需登录或为老视频');
                }
                return { video: dash.video || [], audio: dash.audio || [] };
            };

            // Pick best quality
            const pickQuality = (videoList, audioList) => {
                const vIds = new Set(videoList.map(v => v.id));
                const aIds = new Set(audioList.map(a => a.id));
                let qualities = videoQualities;
                if (S.useHighQuality === false) {
                    qualities = videoQualities.filter(q => !HIGH_QUALITY_IDS.includes(q.id));
                }
                const pv = qualities.find(q => vIds.has(q.id));
                const pa = audioQualities.find(q => aIds.has(q.id));
                return { pickedVideo: pv, pickedAudio: pa };
            };

            // Download a single video (FFmpeg merge video + audio, fallback to separate)
            const dlV = async (v) => {
                // 标题为空时从B站视频信息API获取
                if (!v.title || v.title === '未命名') {
                    try {
                        const infoResp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${v.bvid}`, { credentials: 'include' });
                        const infoJson = await infoResp.json();
                        if (infoJson.code === 0 && infoJson.data?.title) {
                            v.title = infoJson.data.title;
                        }
                    } catch (_) {}
                }
                const cid = await getCid(v.bvid);
                const pu = await getPlayUrl(v, cid);
                const { pickedVideo, pickedAudio } = pickQuality(pu.video, pu.audio);
                const fn = sf(v.title, v.bvid, 60);

                if (!pickedVideo && !pickedAudio) {
                    throw new Error('未找到合适的格式');
                }

                // 音视频都有：用 FFmpeg 合并后下载
                if (pickedVideo && pickedAudio) {
                    const vi = pu.video.find(x => x.id === pickedVideo.id);
                    const ai = pu.audio.find(x => x.id === pickedAudio.id);
                    try {
                        const blob = await mergeVideoAudio(vi.baseUrl, ai.baseUrl);
                        hideFFmpegProgress();
                        saveBlob(blob, fn + '.mp4');
                        return;
                    } catch (mergeErr) {
                        hideFFmpegProgress();
                        console.error('FFmpeg 合并失败，回退到分别下载', mergeErr);
                    }
                }

                // 分别下载（只有一个流 或 合并失败回退）
                if (pickedVideo) {
                    const vi = pu.video.find(x => x.id === pickedVideo.id);
                    await dlF(vi.baseUrl, fn + pickedVideo.ext);
                }
                if (pickedAudio) {
                    const ai = pu.audio.find(x => x.id === pickedAudio.id);
                    await dlF(ai.baseUrl, fn + pickedAudio.ext);
                }
            };

            const dlF = (url, filename) => {
                return new Promise((resolve, reject) => {
                    const xhr = new XMLHttpRequest();
                    xhr.open('GET', url, true);
                    xhr.responseType = 'blob';
                    xhr.setRequestHeader('Referer', 'https://www.bilibili.com');
                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300 && xhr.response && xhr.response.size > 0) {
                            saveBlob(xhr.response, filename);
                            resolve();
                        } else {
                            reject(new Error('下载失败: HTTP ' + xhr.status + ' size=' + (xhr.response ? xhr.response.size : 0)));
                        }
                    };
                    xhr.onerror = () => reject(new Error('网络错误'));
                    xhr.send();
                });
            };

            const saveBlob = (blob, filename) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.setAttribute('download', filename);
                a.style.display = 'none';
                // 阻止 B 站 SPA Router 拦截这个点击事件
                a.addEventListener('click', function(e) {
                    e.stopImmediatePropagation();
                }, true);
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    if (a.parentNode) a.parentNode.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 120000);
            };

            // Sequential download (one by one)
            const seq = async (items, wrk) => {
                for (let i = 0; i < items.length; i++) {
                    await wrk(items[i], i);
                }
            };

            // ── UI: checkboxes ──
            // Extract checkbox injection into standalone function for re-use
            const injCb = (link, bvid) => {
                // 全局去重：同一 BV 号已存在复选框则跳过
                if (document.querySelector(`.bili-sel-cb[data-id="${bvid}"]`)) return;
                // Find card container (B站可能使用不同的容器类名)
                let card = link.closest('li, [class*="card"], [class*="item"], [class*="cube"], [class*="video"], [class*="list"], [class*="grid"]');
                if (!card) card = link.parentElement;
                if (!card || card.querySelector('.bili-sel-cb')) return;

                const cs = getComputedStyle(card);
                if (cs.position === 'static') card.style.position = 'relative';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'bili-sel-cb';
                cb.dataset.id = bvid;
                cb.addEventListener('change', us);
                cb.addEventListener('click', (e) => {
                    if (!S.enabled) return;
                    e.stopPropagation();
                });

                // Click card to toggle checkbox
                card.addEventListener('click', (e) => {
                    if (!S.enabled) return;
                    if (e.target === cb) return;
                    e.preventDefault();
                    e.stopPropagation();
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event('change', { bubbles: true }));
                }, true);

                card.appendChild(cb);
            };

            const getTitleFromLink = (link) => {
                if (link.title) return link.title;
                const aria = link.getAttribute('aria-label');
                if (aria) return aria;
                // B站缩略图链接的class（bili-video-card__image）包含"card"，会被closest匹配到，需向上查找
                const cardSel = 'li, [class*="card"], [class*="item"], [class*="cube"], [class*="video"], [class*="list"], [class*="grid"]';
                let card = link.closest(cardSel);
                if (card === link) card = link.parentElement;
                if (card) {
                    // 优先找带title属性的a标签（B站标题链接的class是 bili-video-card__info--tit）
                    const titleLink = card.querySelector('a[title]');
                    if (titleLink && titleLink.title) return titleLink.title;
                    // 找class含"title"或"tit"的元素
                    const titleEl = card.querySelector('[class*="title"], [class*="tit"]');
                    if (titleEl) return titleEl.textContent?.trim() || titleEl.getAttribute('title') || '';
                    // 找任何有title属性的元素
                    const anyTitle = card.querySelector('[title]');
                    if (anyTitle) return anyTitle.getAttribute('title') || '';
                }
                return '';
            };

            const icl = () => {
                if (!S.enabled) return;
                // 1) Process new links (without data-bili-checked)
                const newLinks = document.querySelectorAll('a[href*="/video/BV"]:not([data-bili-checked]), a[href*="/video/av"]:not([data-bili-checked])');
                newLinks.forEach((link) => {
                    link.setAttribute('data-bili-checked', '1');
                    let href = link.getAttribute('href') || '';
                    if (href.startsWith('//')) href = 'https:' + href;
                    const m = /\/video\/(BV[a-zA-Z0-9]+)/.exec(href) || /\/video\/av(\d+)/.exec(href);
                    if (!m) return;
                    const bvid = m[1];
                    // 无论是否在 S.videos 中，都注入复选框
                    if (!S.videos.has(bvid)) {
                        S.videos.set(bvid, { bvid: bvid, aid: 0, title: getTitleFromLink(link), pic: '', author: '', mid: 0, length: '' });
                    }

                    // Prevent card link navigation when enabled
                    link.addEventListener('click', (e) => {
                        if (!S.enabled) return;
                        e.preventDefault();
                        e.stopPropagation();
                    }, true);

                    injCb(link, bvid);
                });
                // 2) Re-inject checkboxes on cards that lost them (e.g. hover preview destroyed DOM)
                document.querySelectorAll('a[data-bili-checked][href*="/video/"]').forEach((link) => {
                    let href = link.getAttribute('href') || '';
                    if (href.startsWith('//')) href = 'https:' + href;
                    const m = /\/video\/(BV[a-zA-Z0-9]+)/.exec(href) || /\/video\/av(\d+)/.exec(href);
                    if (!m) return;
                    const bvid = m[1];
                    if (!S.videos.has(bvid)) {
                        S.videos.set(bvid, { bvid: bvid, aid: 0, title: getTitleFromLink(link), pic: '', author: '', mid: 0, length: '' });
                    }
                    injCb(link, bvid);
                });
                us();
            };

            const te = () => {
                S.enabled = !S.enabled;
                const tb = document.getElementById('bili-toggle');
                if (tb) {
                    tb.textContent = S.enabled ? '停用下载' : '启用下载';
                    tb.classList.toggle('bili-tb-on', S.enabled);
                }
                document.querySelectorAll('.bili-sel-cb').forEach(c => c.remove());
                document.querySelectorAll('[data-bili-checked]').forEach(el => el.removeAttribute('data-bili-checked'));
                us();
                icl();
            };

            const rv = () => { icl(); };

            const gs = () => Array.from(document.querySelectorAll('.bili-sel-cb:checked')).map(cb => S.videos.get(cb.dataset.id)).filter(Boolean);

            const us = () => {
                const cbs = document.querySelectorAll('.bili-sel-cb');
                const cnt = Array.from(cbs).filter(c => c.checked).length;
                const ce = document.getElementById('bili-count');
                const db = document.getElementById('bili-dl-btn');
                const sa = document.getElementById('bili-sel-all');
                const iv = document.getElementById('bili-invert');
                if (ce) ce.textContent = '已选 ' + cnt + ' 项';
                if (db) {
                    db.disabled = S.downloading || cnt === 0;
                    if (cnt > 0) db.classList.add('bili-tb-primary');
                    else db.classList.remove('bili-tb-primary');
                }
                if (sa) sa.disabled = S.downloading || !S.enabled;
                if (iv) iv.disabled = S.downloading || !S.enabled;
                const allCbs = document.querySelectorAll('.bili-sel-cb');
                allCbs.forEach(c => { c.disabled = S.downloading; });
            };

            const di = async () => {
                if (S.downloading) return;
                const sel = gs();
                if (sel.length === 0) {
                    tst('请选择要下载的内容');
                    return;
                }
                S.downloading = true;
                us();
                try {
                    await seq(sel, async (v) => {
                        try {
                            await dlV(v);
                        } catch (e) {
                            console.error('下载失败:', v.title, e);
                        }
                    });
                } finally {
                    S.downloading = false;
                    us();
                }
            };

            // ── toolbar ──
            const itb = () => {
                if (!document.body) return;
                const exist = document.getElementById('bili-toolbar');
                if (exist && exist.parentNode) return;

                const tb = document.createElement('div');
                tb.id = 'bili-toolbar';
                const label = S.enabled ? '停用下载' : '启用下载';
                const cls = S.enabled ? ' bili-tb-on' : '';
                tb.innerHTML = '<button id="bili-toggle" class="bili-tb-btn' + cls + '">' + label + '</button><button id="bili-sel-all" class="bili-tb-btn" disabled>全选</button><button id="bili-invert" class="bili-tb-btn" disabled>反选</button><span id="bili-count" class="bili-tb-count">已选 0 项</span><button id="bili-dl-btn" class="bili-tb-btn" disabled>下载选中</button>';

                const styleEl = document.createElement('style');
                styleEl.textContent = `
                    .bili-sel-cb {
                        appearance: none;
                        position: absolute;
                        top: 8px;
                        left: 8px;
                        z-index: 999999;
                        width: 20px;
                        height: 20px;
                        border: 2px solid rgba(255,255,255,0.85);
                        border-radius: 5px;
                        cursor: pointer;
                        background: rgba(0,0,0,0.35);
                        transition: all .15s;
                        margin: 0;
                    }
                    .bili-sel-cb:checked {
                        background: #fb7299;
                        border-color: #fb7299;
                    }
                    .bili-sel-cb:checked::after {
                        content: "";
                        position: absolute;
                        left: 5px;
                        top: 2px;
                        width: 5px;
                        height: 9px;
                        border: solid #fff;
                        border-width: 0 2px 2px 0;
                        transform: rotate(45deg);
                    }
                    #bili-toolbar {
                        position: fixed;
                        bottom: 20px;
                        left: 50%;
                        transform: translateX(-50%);
                        z-index: 2147483646;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 10px 18px;
                        background: rgba(0,0,0,0.65);
                        backdrop-filter: blur(16px);
                        -webkit-backdrop-filter: blur(16px);
                        border-radius: 20px;
                        box-shadow: 0 4px 20px rgba(0,0,0,0.35);
                        border: 1px solid #444;
                    }
                    .bili-tb-btn {
                        height: 32px;
                        padding: 0 14px;
                        border: none;
                        border-radius: 16px;
                        background: rgba(255,255,255,0.18);
                        color: #fff;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        white-space: nowrap;
                        transition: background .15s;
                        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
                    }
                    .bili-tb-btn:hover { background: rgba(255,255,255,0.28); }
                    .bili-tb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
                    .bili-tb-on { background: #fb7299; }
                    .bili-tb-on:hover { background: #e05d80; }
                    .bili-tb-primary { background: #fb7299; }
                    .bili-tb-primary:hover:not(:disabled) { background: #e05d80; }
                    .bili-tb-count {
                        color: rgba(255,255,255,0.7);
                        font-size: 12px;
                        font-weight: 500;
                        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
                        white-space: nowrap;
                        min-width: 60px;
                        text-align: center;
                    }
                `;
                document.head.appendChild(styleEl);
                document.body.appendChild(tb);

                document.getElementById('bili-toggle').addEventListener('click', te);
                document.getElementById('bili-sel-all').addEventListener('click', () => {
                    document.querySelectorAll('.bili-sel-cb').forEach(c => { c.checked = true; });
                    us();
                });
                document.getElementById('bili-invert').addEventListener('click', () => {
                    document.querySelectorAll('.bili-sel-cb').forEach(c => { c.checked = !c.checked; });
                    us();
                });
                document.getElementById('bili-dl-btn').addEventListener('click', di);
            };

            // ── init ──
            hx();
            hf();

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    itb();
                    setInterval(icl, 500);
                });
            } else {
                itb();
                setInterval(icl, 500);
            }

            // SPA navigation watch
            let lastUrl = location.href;
            setInterval(() => {
                if (lastUrl !== location.href) {
                    lastUrl = location.href;
                    // 不移除 S.videos，新页面 API 数据会自动通过 hooks 填充
                    // 不重置 S.enabled，保持用户的启用/停用选择
                    document.querySelectorAll('.bili-sel-cb').forEach(c => c.remove());
                    document.querySelectorAll('[data-bili-checked]').forEach(el => el.removeAttribute('data-bili-checked'));
                    // Re-inject toolbar with current state
                    const oldTb = document.getElementById('bili-toolbar');
                    if (oldTb) oldTb.remove();
                    setTimeout(itb, 800);
                }
            }, 800);
        })();
    }

    // B站素材库平台下载按钮
    if (location.hostname === 'cool.bilibili.com') {
        function downloadVideoFile(url, filename) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'blob';
            xhr.setRequestHeader('Referer', location.href);
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    var blob = xhr.response;
                    var blobUrl = URL.createObjectURL(blob);
                    var a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1000);
                }
            };
            xhr.send();
        }
        function tryAddBut() {
            if (addBut()) return;
            var observer = new MutationObserver(function () {
                if (addBut()) observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        function addBut() {
            var gotoUse = document.getElementsByClassName('goto-use')[0];
            if (!gotoUse) return false;

            if (document.getElementById('cool-download-btn')) return true;

            var titleEl = document.getElementsByClassName('info-card-title')[0];

            var but = document.createElement("button");
            but.id = 'cool-download-btn';
            but.textContent = "去下载";
            but.style = "display: inline-block;margin-left: 12px;padding: 5px 36px;font-size: 14px;line-height: 28px;margin-bottom: -22px;text-align: center;background: #20aae2;border: 1px solid #20aae2;color: #fff;border-radius: 20px;box-sizing: border-box;cursor: pointer;vertical-align: middle;";
            but.onclick = function () {
                var title = titleEl ? (titleEl.textContent || titleEl.innerText).trim() : '素材';
                var videoSrc = document.getElementsByTagName('video')[0].src;
                downloadVideoFile(videoSrc, title + '.mp4');
            };
            gotoUse.style.display = 'inline-block';
            gotoUse.style.verticalAlign = 'middle';
            gotoUse.parentNode.insertBefore(but, gotoUse.nextSibling);
            return true;
        }
        tryAddBut();
    }

    // === 评论区提取 ===
    function escMD(text) {
        var s = String(text);
        s = s.replace(/\\/g, '\\\\');
        s = s.replace(/^([#>*`~\-+={}!|])/gm, '\\$1');
        s = s.replace(/^(\d+)\.(\s)/gm, '$1\\.$2');
        s = s.replace(/([*_`\[\]()])/g, '\\$1');
        return s;
    }

    function toMD(comments, info) {
        var top = comments.slice().sort(function(a, b) { return b.like - a.like; }).slice(0, 20);
        var md = '## 视频信息\n\n';
        md += '- **标题**：' + info.title + '\n- **UP主**：' + info.upName + '\n';
        if (info.bvid) md += '- **BV号**：' + info.bvid + '\n';
        md += '- **视频链接**：' + location.href + '\n- **导出时间**：' + new Date().toLocaleString('zh-CN') + '\n\n';
        md += '## 热门评论\n\n';
        top.forEach(function(c, i) { md += (i+1) + '. **' + c.name + '** (??' + c.like + ')：' + escMD(c.text) + '\n'; });
        md += '\n## 全部评论\n\n';
        comments.forEach(function(c, i) {
            md += (i+1) + '. **' + c.name + '**：' + escMD(c.text) + '\n';
            c.replies.forEach(function(r) {
                md += '    **' + r.name + '**：' + escMD(r.text) + '\n';
            });
        });
        return md;
    }

    var cmtStatusEl = null;
    function showCmtStatus(msg) {
        if (!cmtStatusEl) {
            cmtStatusEl = document.createElement('div');
            cmtStatusEl.style.cssText = 'position:fixed;top:5%;left:50%;transform:translateX(-50%);background:#3F7FEA;color:#fff;padding:16px 18px;min-height:20px;min-width:180px;line-height:1.2;border-radius:13px;font-size:14px;font-family:sans-serif;z-index:2147483647;pointer-events:none;box-shadow:0 2px 8px rgba(0,122,255,0.25),0 0 0 0.5px rgba(0,122,255,0.1);box-sizing:border-box;display:flex;align-items:center;justify-content:center;';
            document.body.appendChild(cmtStatusEl);
        }
        cmtStatusEl.textContent = msg;
    }
    function hideCmtStatus() {
        if (cmtStatusEl) { cmtStatusEl.remove(); cmtStatusEl = null; }
    }

    async function extractComments() {
        try {
            showCmtStatus('正在获取视频信息...');
            var videoData = window.__INITIAL_STATE__?.videoData;
            var bvid = videoData?.bvid || (location.pathname.match(/\/video\/(BV\w+)/) || [])[1];
            var title = videoData?.title || document.title || '';
            var upName = videoData?.owner?.name || '';
            var aid = videoData?.aid || window.__INITIAL_STATE__?.aid || 0;
            if (!aid) {
                var scripts = document.querySelectorAll('script');
                for (var si = 0; si < scripts.length; si++) {
                    var m = (scripts[si].textContent || '').match(/"aid"\s*:\s*(\d+)/);
                    if (m) { aid = parseInt(m[1], 10); break; }
                }
            }
            if (!aid && bvid) {
                try {
                    var infoResp = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { credentials: 'include' });
                    var infoData = await infoResp.json();
                    if (infoData.code === 0) {
                        aid = infoData.data.aid;
                        if (!title) title = infoData.data.title || '';
                        if (!upName) upName = infoData.data.owner?.name || '';
                    }
                } catch(e) {}
            }
            if (!aid) { hideCmtStatus(); showToast('无法获取视频 aid', 2000); return; }
            var maxPages = 8, pageSize = 20, sortType = 2, commentLimit = 188;
            var all = [], minDelay = 1800, maxDelay = 3800;

            async function fetchSubReplies(rootRpid) {
                var replies = [];
                var subPage = 1;
                while (true) {
                    var subUrl = 'https://api.bilibili.com/x/v2/reply/reply?type=1&oid=' + aid + '&root=' + rootRpid + '&pn=' + subPage + '&ps=20';
                    try {
                        var subResp = await fetch(subUrl, { credentials: 'include', headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': location.href } });
                        if (!subResp.ok) break;
                        var subData = await subResp.json();
                        if (subData.code !== 0) break;
                        var pageReplies = subData.data?.replies;
                        if (!pageReplies || pageReplies.length === 0) break;
                        replies.push.apply(replies, pageReplies);
                        if (pageReplies.length < 20) break;
                        subPage++;
                        await new Promise(function(r) { setTimeout(r, 200 + Math.random() * 200); });
                    } catch(e) { break; }
                }
                return replies;
            }

            for (var page = 1; page <= maxPages; page++) {
                if (page > 1) {
                    await new Promise(function(r) { setTimeout(r, minDelay + Math.random() * (maxDelay - minDelay)); });
                }
                try {
                    var resp = await fetch('https://api.bilibili.com/x/v2/reply?type=1&oid=' + aid + '&pn=' + page + '&ps=' + pageSize + '&sort=' + sortType, { credentials: 'include', headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': location.href } });
                    if (!resp.ok) continue;
                    var data = await resp.json();
                    if (data.code !== 0) continue;
                    var replies = data.data?.replies;
                    if (!replies || replies.length === 0) break;
                    for (var ri = 0; ri < replies.length; ri++) {
                        if (all.length >= commentLimit) break;
                        var r = replies[ri];
                        var item = { name: r.member?.uname || '匿名', text: r.content?.message || '', like: r.like || 0, replies: [] };
                        if (r.rpid) {
                            var inlineReplies = Array.isArray(r.replies) ? r.replies : [];
                            var expectedCount = r.rcount || inlineReplies.length;
                            var allSubs = [].concat(inlineReplies);
                            if (expectedCount > inlineReplies.length) {
                                try {
                                    var fetched = await fetchSubReplies(r.rpid);
                                    var seen = {};
                                    allSubs = inlineReplies.concat(fetched).filter(function(s) {
                                        var key = s.rpid || '';
                                        if (!key || seen[key]) return false;
                                        seen[key] = true; return true;
                                    });
                                } catch(e) {}
                            }
                            for (var sri = 0; sri < allSubs.length; sri++) {
                                if (item.replies.length >= 20) break;
                                var sub = allSubs[sri];
                                item.replies.push({ name: sub.member?.uname || '匿名', text: sub.content?.message || '', like: sub.like || 0 });
                            }
                        }
                        all.push(item);
                    }
                    showCmtStatus('已获取 ' + all.length + ' 条评论...');
                    if (replies.length < pageSize || all.length >= commentLimit) break;
                } catch(e) { break; }
            }
            if (!all.length) { hideCmtStatus(); showToast('该视频没有评论', 2000); return; }
            showCmtStatus('正在生成 Markdown...');
            var md = toMD(all, { title: title, upName: upName, bvid: bvid });
            var safeTitle = (upName || '未知UP主').replace(/[\\/:*?"<>|]/g, '_') + '_' + (title || '未知标题').replace(/[\\/:*?"<>|]/g, '_') + '_评论区.md';
            var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = safeTitle;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            hideCmtStatus();
            showToast('已导出 ' + all.length + ' 条评论', 3000);
        } catch(err) {
            hideCmtStatus();
            showToast('提取失败：' + String(err.message), 3000);
        }
    }

    // ═══════════════════════════════════════════
    //  干掉新版b站评论区的搜索 (放大镜/蓝字) 功能
    //  作者 DuckBurnIncense，原脚本 MIT
    //  https://greasyfork.org/zh-CN/scripts/447612
    //  匿名块防止b站通过特定变量名屏蔽脚本
    // ═══════════════════════════════════════════
    (function killCommentSearchFeature() {
        if (typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;

        // 是否把关键词替换为不可点击的斜体（调试用，默认禁用）
        var changeToItalic = GM_getValue('changeToItalic', 0);
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand((changeToItalic ? '[??已启用]' : '[?已禁用]') + " 将关键词替换为斜体", function() {
                GM_setValue('changeToItalic', !changeToItalic);
                alert('修改成功, 刷新页面后生效');
            });
        }

        // 是否适配 "Bilibili 翻页评论区" 脚本
        var fanye = GM_getValue('fanye', 0);
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand((fanye ? '[??已启用]' : '[?已禁用]') + " 兼容脚本 \"Bilibili 翻页评论区\"", function() {
                GM_setValue('fanye', !fanye);
                alert('修改成功, 刷新页面后生效');
            });
        }

        // 判断浏览器类型
        var browserType = (navigator.userAgent.indexOf('Chrome') != -1) ? 'Chrome' : 'Firefox';

        // 替换 a 标签的正则表达式
        var searchWordsOuterHTMLRegexr = /^(?:<a.*?>)(.*)(?:<\/a>)$/gim;

        // queries：a=蓝字, i=放大镜图标, browser=支持的浏览器, fanye=是否适配翻页脚本
        var queries = [
            { a: 'a.jump-link.search-word',                  i: 'i.icon.search-word',                                     browser: ['Chrome', 'Firefox'], fanye: false },
            { a: 'a.comment-jump-url[href*="undefined"]',    i: 'img.jump-img:not([src*="bfs/activity-plat/static"])',    browser: ['Chrome', 'Firefox'], fanye: true  },
            { a: 'a.underline-link.comment-jump-url',        i: 'i.underline.jump-img',                                   browser: ['Chrome', 'Firefox'], fanye: false },
        ];

        // 评论区异步加载，定时重复执行
        setInterval(function() {
            queries.forEach(function(query) {
                if (query.browser.indexOf(browserType) === -1 || fanye != query.fanye) return;
                var words = document.querySelectorAll(query.a);
                var icons = document.querySelectorAll(query.i);
                var swapOne = function(word) {
                    word.outerHTML = word.outerHTML.replace(searchWordsOuterHTMLRegexr, changeToItalic ? '<span style="font-style:italic;">$1</span>' : '$1');
                };
                words.forEach(swapOne);
                icons.forEach(function(icon) { icon.remove(); });
            });

            // b 站 ShadowRoot 技术（2024-07 起）
            var biliComments = document.querySelector('bili-comments');
            if (biliComments && biliComments.shadowRoot) {
                biliComments.shadowRoot.querySelectorAll('bili-comment-thread-renderer').forEach(function(biliCommentThreadRenderer) {
                    biliCommentThreadRenderer.shadowRoot.querySelectorAll('bili-comment-renderer').forEach(function(biliCommentRenderer) {
                        biliCommentRenderer.shadowRoot.querySelectorAll('bili-rich-text').forEach(function(biliRichText) {
                            biliRichText.shadowRoot.querySelectorAll('a[href^="//search.bilibili.com/all?from_source=webcommentline_search"]').forEach(function(a) {
                                var img = a.querySelector('img');
                                if (img) img.remove();
                                a.outerHTML = a.outerHTML.replace(searchWordsOuterHTMLRegexr, changeToItalic ? '<span style="font-style:italic;">$1</span>' : '$1');
                            });
                        });
                    });
                    biliCommentThreadRenderer.shadowRoot.querySelectorAll('bili-comment-replies-renderer').forEach(function(biliCommentRepliesRenderer) {
                        biliCommentRepliesRenderer.shadowRoot.querySelectorAll('bili-comment-reply-renderer').forEach(function(biliCommentReplyRenderer) {
                            biliCommentReplyRenderer.shadowRoot.querySelectorAll('bili-rich-text').forEach(function(biliRichText) {
                                biliRichText.shadowRoot.querySelectorAll('a[href^="//search.bilibili.com/all?from_source=webcommentline_search"]').forEach(function(a) {
                                    var img = a.querySelector('img');
                                    if (img) img.remove();
                                    a.outerHTML = a.outerHTML.replace(searchWordsOuterHTMLRegexr, changeToItalic ? '<span style="font-style:italic;">$1</span>' : '$1');
                                });
                            });
                        });
                    });
                });
            }
        }, 1000);
    })();
})();
