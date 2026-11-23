(function(){
  var viewer = document.getElementById('viewer');
  if (!viewer) return;

  var canvas = document.getElementById('viewerCanvas');
  var ctx = canvas.getContext('2d');
  var closeBtn = document.getElementById('viewerClose');
  var dl = document.getElementById('viewerDownload');
  var counter = document.getElementById('viewerCount');

  var CARDS = {};
  try { CARDS = JSON.parse(viewer.getAttribute('data-cards') || '{}'); } catch (e) {}

  var floors = [], idx = 0, cache = {};

  function loadOne(src){
    return new Promise(function(res){
      if (!src) return res(null);
      if (cache[src] !== undefined) return res(cache[src]);
      var im = new Image();
      im.onload = function(){ cache[src] = im; res(im); };
      im.onerror = function(){ cache[src] = null; res(null); };
      im.src = src;
    });
  }

  // 候选背景按随机顺序逐个尝试，取第一张能加载的；全失败返回 null 用渐变兜底
  function loadBg(v){
    var list = Array.isArray(v) ? v.slice() : (v ? [v] : []);
    for (var i = list.length - 1; i > 0; i--){
      var j = Math.floor(Math.random() * (i + 1));
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list.reduce(function(chain, src){
      return chain.then(function(img){ return img ? img : loadOne(src); });
    }, Promise.resolve(null));
  }

  function wrap(text, maxW){
    var lines = [], line = '';
    for (var i = 0; i < text.length; i++){
      var ch = text.charAt(i);
      var t = line + ch;
      if (ctx.measureText(t).width > maxW && line){ lines.push(line); line = ch; }
      else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  function paint(nick, sign, text, img){
    var W = img ? img.naturalWidth : 1080;
    var H = img ? img.naturalHeight : 1440;
    canvas.width = W; canvas.height = H;

    if (img) {
      ctx.drawImage(img, 0, 0, W, H);
    } else {
      var gr = ctx.createLinearGradient(0, 0, W, H);
      gr.addColorStop(0, '#2a251f'); gr.addColorStop(1, '#443a2e');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
    }

    var pad = Math.round(W * 0.08);
    var maxW = W - pad * 2;
    var y = Math.round(H * 0.18);

    ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,.4)';
    ctx.shadowBlur = Math.round(W * 0.012);

    ctx.font = 'bold ' + Math.round(W * 0.052) + 'px "Songti SC","Noto Serif SC",serif';
    ctx.fillText(nick || '匿名', pad, y);
    y += Math.round(W * 0.08);

    if (sign){
      ctx.globalAlpha = 0.72;
      ctx.font = Math.round(W * 0.028) + 'px "Songti SC","Noto Serif SC",serif';
      ctx.fillText(sign, pad, y);
      ctx.globalAlpha = 1;
      y += Math.round(W * 0.062);
    }

    var fs = W * 0.036, lines = [], lh = 0;
    for (var k = 0; k < 5; k++){
      ctx.font = Math.round(fs) + 'px "Songti SC","Noto Serif SC",serif';
      lines = wrap(text || '（这一层没有正文）', maxW);
      lh = Math.round(fs * 1.75);
      if (y + lines.length * lh <= H - pad) break;
      fs *= 0.87;
    }

    var maxLines = Math.floor((H - pad - y) / lh);
    if (maxLines > 0 && lines.length > maxLines){
      lines = lines.slice(0, maxLines);
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + '\u2026';
    }

    for (var j = 0; j < lines.length; j++){
      ctx.fillText(lines[j], pad, y);
      y += lh;
    }
    ctx.shadowBlur = 0;

    prepareDownload();
  }

  function prepareDownload(){
    var f = floors[idx];
    var nick = f ? (f.getAttribute('data-nick') || 'card') : 'card';
    if (canvas.toBlob){
      canvas.toBlob(function(blob){
        if (!blob) return;
        if (dl.dataset.url) URL.revokeObjectURL(dl.dataset.url);
        var u = URL.createObjectURL(blob);
        dl.dataset.url = u;
        dl.href = u;
        dl.download = nick + '.png';
      }, 'image/png');
    } else {
      dl.href = canvas.toDataURL('image/png');
      dl.download = nick + '.png';
    }
  }

  function renderCurrent(){
    var f = floors[idx];
    if (!f) return;
    var nick = f.getAttribute('data-nick') || '匿名';
    var sign = f.getAttribute('data-sign') || '';
    var text = f.getAttribute('data-text') || '';
    counter.textContent = (idx + 1) + ' / ' + floors.length;

    loadBg(CARDS[nick]).then(function(img){
      paint(nick, sign, text, img);
      canvas.style.animation = 'none';
      void canvas.offsetWidth;
      canvas.style.animation = 'viewerIn .2s ease';
    });
  }

  function go(step){
    var n = idx + step;
    if (n < 0 || n >= floors.length) return;
    idx = n;
    renderCurrent();
  }

  function open(startFloor){
    floors = Array.prototype.slice.call(document.querySelectorAll('.floor[data-nick]'));
    idx = Math.max(0, floors.indexOf(startFloor));
    viewer.classList.add('on');
    document.body.style.overflow = 'hidden';
    renderCurrent();
  }

  function close(){
    viewer.classList.remove('on');
    document.body.style.overflow = '';
    var f = floors[idx];
    if (f && f.scrollIntoView){
      setTimeout(function(){ f.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 40);
    }
  }

  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    var btn = t.closest('.fcard');
    if (btn) open(btn.closest('.floor'));
  });

  closeBtn.addEventListener('click', close);

  var startY = 0, tracking = false;
  viewer.addEventListener('touchstart', function(e){
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  viewer.addEventListener('touchmove', function(e){
    if (tracking && e.cancelable) e.preventDefault();
  }, { passive: false });

  viewer.addEventListener('touchend', function(e){
    if (!tracking) return;
    tracking = false;
    var dy = e.changedTouches[0].clientY - startY;
    if (dy < -50) go(1);
    else if (dy > 50) go(-1);
  });

  var lock = false;
  viewer.addEventListener('wheel', function(e){
    if (lock || Math.abs(e.deltaY) < 15) return;
    lock = true;
    setTimeout(function(){ lock = false; }, 280);
    go(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  document.addEventListener('keydown', function(e){
    if (!viewer.classList.contains('on')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') go(1);
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') go(-1);
  });
})();
