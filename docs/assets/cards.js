(function(){
  var modal = document.getElementById('cardModal');
  if (!modal) return;
  var CARDS = {};
  try { CARDS = JSON.parse(modal.getAttribute('data-cards') || '{}'); } catch (e) {}
  var canvas = document.getElementById('cardCanvas');
  var ctx = canvas.getContext('2d');
  var dl = document.getElementById('cardDownload');
  var closeBtn = document.getElementById('cardClose');
  var cache = {};

  function load(src){
    return new Promise(function(res){
      if (!src) return res(null);
      if (cache[src] !== undefined) return res(cache[src]);
      var im = new Image();
      im.onload = function(){ cache[src] = im; res(im); };
      im.onerror = function(){ cache[src] = null; res(null); };
      im.src = src;
    });
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

  function render(nick, sign, text, img){
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
      lines[lines.length - 1] = lines[lines.length - 1].slice(0, -1) + '…';
    }

    for (var j = 0; j < lines.length; j++){
      ctx.fillText(lines[j], pad, y);
      y += lh;
    }
    ctx.shadowBlur = 0;

    if (canvas.toBlob){
      canvas.toBlob(function(blob){
        if (!blob) return;
        dl.href = URL.createObjectURL(blob);
        dl.download = (nick || 'card') + '.png';
      }, 'image/png');
    } else {
      dl.href = canvas.toDataURL('image/png');
      dl.download = (nick || 'card') + '.png';
    }
  }

  function open(floor){
    var nick = floor.getAttribute('data-nick') || '匿名';
    var sign = floor.getAttribute('data-sign') || '';
    var text = floor.getAttribute('data-text') || '';
    modal.classList.add('on');
    load(CARDS[nick]).then(function(img){ render(nick, sign, text, img); });
  }

  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t) return;

    if (t === modal || t === closeBtn || (t.closest && t.closest('#cardClose'))){
      modal.classList.remove('on');
      return;
    }
    if (modal.classList.contains('on')) return;      // 弹层开着时不响应楼层
    if (t.closest && t.closest('a')) return;         // 点链接不弹
    var sel = window.getSelection ? String(window.getSelection()) : '';
    if (sel && sel.trim()) return;                   // 选中文字时不弹

    var floor = t.closest ? t.closest('.floor') : null;
    if (floor) open(floor);
  });

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape') modal.classList.remove('on');
  });
})();
