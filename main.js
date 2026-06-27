'use strict';

/* =========================================================================
 * yacht — トップダウンのヨット・タイムアタック
 *  - 船体は常に画面中央で水平（左右どちらか向き）に固定し、背景を回転させる
 *  - 5個の島をすべて巡るとクリア。ステージ番号→固定シードで島配置・風を再現
 * ====================================================================== */

/* ----------------------------- 定数 ----------------------------------- */
const L            = 3.0;            // 船体長（ワールド単位）
const SCALE        = 24;             // ワールド→pxの拡大率
const SEA          = '#2a6db0';      // 海の色
const WAVE_CELL    = 8;               // 波を1つ置くグリッド間隔（ワールド単位）
const WAVE_COLOR   = '#7fa7d0';       // 海色と白の中間色
const R_WORLD      = 80;             // 島を配置する半径
const START_CLEAR  = 15;             // スタート地点まわりの空き
const MIN_SEP      = 11;             // 島どうしの最小間隔
const NUM_ISLANDS  = 5;              // 1ステージあたりの島の数
const NUM_STAGES   = 8;              // ステージ数
const VISIT_MARGIN = L;              // 島の半径＋この距離で訪問判定

const SAIL_C       = 2.2;            // 帆の推力係数
const DRAG         = 0.7;            // 水の抵抗（速度に比例）
const RUDDER_DRAG  = 0.35;           // 舵を切ったときの減速
const RUDDER_K     = 0.12;           // 旋回係数（角速度 = K * 舵角 * 速度）
const SAIL_MAX     = Math.PI * 0.46; // 帆の最大開き角（約83°）
const RUDDER_MAX   = 0.7;            // 舵の最大角（約40°）

const WIND_DT      = 4;              // 風キーフレーム間隔(秒)
const WIND_N       = 240;            // キーフレーム数（約16分ぶん）

/* --------------------------- 乱数（シード付き） ------------------------ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------- ステージ生成 ----------------------------- */
function genStage(stageNum) {
  const rng = mulberry32((stageNum * 0x9E3779B1) >>> 0);

  // 島
  const islands = [];
  let tries = 0;
  while (islands.length < NUM_ISLANDS && tries < 4000) {
    tries++;
    const ang  = rng() * Math.PI * 2;
    const dist = START_CLEAR + rng() * (R_WORLD - START_CLEAR);
    const x = Math.cos(ang) * dist, y = Math.sin(ang) * dist;
    const r = 2 + rng() * 3;
    let ok = Math.hypot(x, y) > START_CLEAR + r;
    for (const o of islands) {
      if (Math.hypot(x - o.x, y - o.y) < o.r + r + MIN_SEP) { ok = false; break; }
    }
    if (ok) islands.push({ x, y, r, visited: false });
  }

  // 風シーケンス（向きは連続値の弱いランダムウォーク）
  const keys = [];
  let dir = rng() * Math.PI * 2;
  let mag = 6 + rng() * 3;
  for (let i = 0; i < WIND_N; i++) {
    keys.push({ dir, mag });
    dir += (rng() - 0.5) * 0.6;
    mag += (rng() - 0.5) * 1.5;
    mag = Math.max(3, Math.min(11, mag));
  }
  return { islands, windKeys: keys };
}

// 経過時間 t における風（向き・強さ）。プレイヤー操作に依存せず再現される。
function windAt(stage, t) {
  const k = stage.windKeys;
  const f = t / WIND_DT;
  let i = Math.floor(f);
  if (i >= k.length - 1) { const e = k[k.length - 1]; return { dir: e.dir, mag: e.mag }; }
  const a = f - i, k0 = k[i], k1 = k[i + 1];
  return { dir: k0.dir + (k1.dir - k0.dir) * a, mag: k0.mag + (k1.mag - k0.mag) * a };
}

/* ----------------------------- 状態 ----------------------------------- */
let state = 'select';          // 'select' | 'play' | 'clear'
let stage = null, stageNum = 1;
let pos = { x: 0, y: 0 };      // 船の位置（ワールド）
let v = 0;                     // 船首方向の速度（負＝後進）
let theta = 0;                 // 船首の向き（ワールド・ラジアン）
let facing = 1;                // +1: 画面右向き / -1: 画面左向き
let viewRot = 0, viewTarget = 0;  // サイドチェンジの視点回転（アニメーション用）
let sailA = 0.3;              // 帆の開き角（大きさ）
let rudderB = 0;               // 舵角
let time = 0;                  // 経過時間(秒)
let visitedCount = 0;

function startStage(n) {
  stageNum = n;
  stage = genStage(n);
  pos = { x: 0, y: 0 };
  v = 0; theta = 0; facing = 1; sailA = 0.3; rudderB = 0; time = 0; visitedCount = 0;
  viewRot = 0; viewTarget = 0;
  updateMinimapSide();
  state = 'play';
  show('select', false); show('clear', false); show('help', false); show('menu', false);
}

function finishStage() {
  state = 'clear';
  setBest(stageNum, time);
  const best = getBests()[stageNum];
  document.getElementById('clear-msg').innerHTML =
    `STAGE ${stageNum}<br>タイム: <b>${fmt(time)}</b><br>ベスト: ${fmt(best)}`;
  show('clear', true);
}

/* ------------------------- ベストタイム保存 --------------------------- */
function getBests() {
  try { return JSON.parse(localStorage.getItem('yacht-bests') || '{}'); }
  catch (e) { return {}; }
}
function setBest(n, t) {
  const b = getBests();
  if (b[n] == null || t < b[n]) { b[n] = t; localStorage.setItem('yacht-bests', JSON.stringify(b)); }
}
function fmt(t) {
  if (t == null) return '--:--.--';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const c = Math.floor((t * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/* ------------------------- 物理（帆まわり） --------------------------- */
// 仕様の力の分解をまとめて計算。描画と更新で共用する。
function sailModel() {
  const f = { x: Math.cos(theta), y: Math.sin(theta) };          // 船首方向
  const p = { x: -Math.sin(theta), y: Math.cos(theta) };          // 左舷方向
  const w = windAt(stage, time);
  const Wt = { x: Math.cos(w.dir) * w.mag, y: Math.sin(w.dir) * w.mag }; // 真の風
  const Wa = { x: Wt.x - v * f.x, y: Wt.y - v * f.y };            // 見かけの風 = 真の風 - 自船速度

  // 帆は風下側へ自動で開く（ブームの左右を風で決める）
  const lateral = Wa.x * p.x + Wa.y * p.y;
  const leeSign = lateral >= 0 ? 1 : -1;
  const boomAngle = theta + Math.PI - leeSign * sailA;

  // 帆に垂直な成分 → 帆に働く力
  const n = { x: -Math.sin(boomAngle), y: Math.cos(boomAngle) };  // 帆に垂直
  const wperp = Wa.x * n.x + Wa.y * n.y;
  const F = { x: SAIL_C * wperp * n.x, y: SAIL_C * wperp * n.y };

  // 船首方向に平行な成分だけが推力に寄与（垂直成分はキールが受ける＝横流れ無視）
  const drive = F.x * f.x + F.y * f.y;

  return { f, p, Wa, boomAngle, drive };
}

function update(dt) {
  // サイドチェンジの回転アニメーション（180°を約0.4秒で）
  const m2 = 2 * Math.PI;
  const vdiff = viewTarget - viewRot;
  if (Math.abs(vdiff) > 1e-4) {
    viewRot += Math.sign(vdiff) * Math.min((Math.PI / 0.4) * dt, Math.abs(vdiff));
  } else {
    viewRot = viewTarget = ((viewTarget % m2) + m2) % m2;  // 肥大化防止
  }

  const m = sailModel();
  // 速度更新（推力 − 水の抵抗 − 舵抵抗）
  v += (m.drive - DRAG * v - RUDDER_DRAG * Math.abs(rudderB) * v) * dt;
  // 旋回（速度に比例。停止中は曲がれない）。舵を向けた側へ船首が向く
  theta -= RUDDER_K * rudderB * v * dt;
  // 位置更新
  pos.x += v * Math.cos(theta) * dt;
  pos.y += v * Math.sin(theta) * dt;
  time += dt;

  // 訪問判定（当たり判定なし＝近接でOK）
  for (const isl of stage.islands) {
    if (!isl.visited && Math.hypot(pos.x - isl.x, pos.y - isl.y) < isl.r + VISIT_MARGIN) {
      isl.visited = true; visitedCount++;
    }
  }
  if (visitedCount >= NUM_ISLANDS) finishStage();
}

/* ----------------------------- 描画 ----------------------------------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const mini = document.getElementById('minimap');
const mctx = mini.getContext('2d');
let dpr = Math.min(window.devicePixelRatio || 1, 2);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';  // CSS表示サイズを実寸に
  }
}

/* 海面の波（ワールド絶対座標に固定。島と同様に動かず、進行方向の目印になる） */
function waveSeed(i, j) {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ (i & 0xffff), 16777619);
  h = Math.imul(h ^ ((i >> 16) & 0xffff), 16777619);
  h = Math.imul(h ^ (j & 0xffff), 16777619);
  h = Math.imul(h ^ ((j >> 16) & 0xffff), 16777619);
  return h >>> 0;
}

function drawWaves() {
  // 画面に映るワールド範囲（回転を考慮し外接円で覆う）
  const R = 0.5 * Math.hypot(window.innerWidth, window.innerHeight) / SCALE + WAVE_CELL;
  const i0 = Math.floor((pos.x - R) / WAVE_CELL), i1 = Math.ceil((pos.x + R) / WAVE_CELL);
  const j0 = Math.floor((pos.y - R) / WAVE_CELL), j1 = Math.ceil((pos.y + R) / WAVE_CELL);
  ctx.fillStyle = WAVE_COLOR;
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const rng = mulberry32(waveSeed(i, j));
      const wx = (i + rng()) * WAVE_CELL;       // セル内でジッター（位置は固定）
      const wy = (j + rng()) * WAVE_CELL;
      const r = 0.28 + rng() * 0.18;
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);        // 小さな円
      ctx.fill();
    }
  }
}

/* 旋回半径に対応した進路を白点線で海面（ワールド座標）に描く。
   進路の曲率 κ = -RUDDER_K·舵角（速度に依存しない一定値）→ 円弧になる */
// 進路（円弧）のワールド座標の点列を返す。停止中は null。メイン画面とミニマップで共用
function pathPoints() {
  if (Math.abs(v) < 0.05) return null;             // 停止中は描かない
  const kappa = -RUDDER_K * rudderB;
  const dir = v >= 0 ? 1 : -1;                      // 後進時は逆向きに伸ばす
  let len = 45;                                     // 先読みする弧長（ワールド単位）
  if (Math.abs(kappa) > 1e-5) len = Math.min(len, (Math.PI * 1.8) / Math.abs(kappa));
  const N = 40;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const s = dir * len * (i / N);
    let x, y;
    if (Math.abs(kappa) < 1e-5) {                   // 直進（舵中央）
      x = pos.x + Math.cos(theta) * s;
      y = pos.y + Math.sin(theta) * s;
    } else {                                        // 円弧
      x = pos.x + (Math.sin(theta + kappa * s) - Math.sin(theta)) / kappa;
      y = pos.y + (Math.cos(theta) - Math.cos(theta + kappa * s)) / kappa;
    }
    pts.push({ x, y });
  }
  return pts;
}

function drawPath() {
  const pts = pathPoints();
  if (!pts) return;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.11;
  ctx.lineCap = 'round';
  ctx.setLineDash([0.6, 0.9]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function render() {
  resize();
  const W = window.innerWidth, H = window.innerHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = SEA;
  ctx.fillRect(0, 0, W, H);

  if (stage && (state === 'play' || state === 'clear')) {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(SCALE, SCALE);
    ctx.rotate(viewR());  // 背景を回転（船首→画面左右）。サイドチェンジでアニメーション
    ctx.translate(-pos.x, -pos.y);

    drawWaves();   // 海面の波（島より下に描く）

    for (const isl of stage.islands) {
      ctx.beginPath();
      ctx.arc(isl.x, isl.y, isl.r, 0, Math.PI * 2);
      ctx.fillStyle = '#2e9e3f';                 // 島の色は訪問後も変えない
      ctx.fill();
    }
    drawPath();    // 旋回半径に対応した進路（白点線）
    drawBoat();
    ctx.restore();

    // 訪問済みの島に赤い旗（画面に対して直立。風向きで左右2パターン）
    const wf = windAt(stage, time);
    const Rv = viewR();
    const flagRight = Math.cos(wf.dir + Rv) >= 0;
    for (const isl of stage.islands) {
      if (!isl.visited) continue;
      const s = worldToScreen(isl.x, isl.y);
      drawFlag(ctx, s.x, s.y, flagRight, 1);
    }
  }
  updateHud();
  renderMinimap();
}

// ワールド座標 → 画面座標（メイン画面の変換と一致させる）
function worldToScreen(wx, wy) {
  const R = viewR();
  const cs = Math.cos(R), sn = Math.sin(R);
  const ox = wx - pos.x, oy = wy - pos.y;
  const rx = ox * cs - oy * sn, ry = ox * sn + oy * cs;
  return { x: window.innerWidth / 2 + rx * SCALE, y: window.innerHeight / 2 + ry * SCALE };
}

// 赤い旗（縦棒＋横向きの三角旗）。scale で大きさ調整、flagRight で左右反転
function drawFlag(g, sx, sy, flagRight, scale) {
  const poleH = 26 * scale, fw = 16 * scale, fh = 11 * scale;
  const dir = flagRight ? 1 : -1;
  const top = sy - poleH;
  g.lineCap = 'round';
  g.strokeStyle = '#eaeaea';
  g.lineWidth = Math.max(1, 2.4 * scale);
  g.beginPath();
  g.moveTo(sx, sy);
  g.lineTo(sx, top);                              // 縦棒
  g.stroke();
  g.beginPath();                                  // 横向きの三角旗
  g.moveTo(sx, top);
  g.lineTo(sx + dir * fw, top + fh / 2);
  g.lineTo(sx, top + fh);
  g.closePath();
  g.fillStyle = '#e23b3b';
  g.fill();
}

function drawBoat() {
  const m = sailModel();
  const f = { x: Math.cos(theta), y: Math.sin(theta) };
  const p = { x: -Math.sin(theta), y: Math.cos(theta) };
  const P = (lx, ly) => ({ x: pos.x + lx * f.x + ly * p.x, y: pos.y + lx * f.y + ly * p.y });

  // 船体（船形・brown）
  const B = L * 0.22;
  const hull = [P(L * 0.5, 0), P(L * 0.18, B), P(-L * 0.5, B * 0.7), P(-L * 0.5, -B * 0.7), P(L * 0.18, -B)];
  ctx.beginPath();
  ctx.moveTo(hull[0].x, hull[0].y);
  for (let i = 1; i < hull.length; i++) ctx.lineTo(hull[i].x, hull[i].y);
  ctx.closePath();
  ctx.fillStyle = '#7a4a22';
  ctx.fill();

  const mast = P(L / 6, 0);   // 帆・ウィンデックスの軸（船首から1/3）
  ctx.lineCap = 'round';

  // 帆（white）: 長さ 2/3
  const bs = { x: Math.cos(m.boomAngle), y: Math.sin(m.boomAngle) };
  ctx.beginPath();
  ctx.moveTo(mast.x, mast.y);
  ctx.lineTo(mast.x + bs.x * (2 * L / 3), mast.y + bs.y * (2 * L / 3));
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = L * 0.06;
  ctx.stroke();

  // ウィンデックス（red）: マストを軸に、見かけの風の風下（吹いていく向き）へ伸ばす
  const wl = Math.hypot(m.Wa.x, m.Wa.y) || 1;
  const wf = { x: m.Wa.x / wl, y: m.Wa.y / wl };
  ctx.beginPath();
  ctx.moveTo(mast.x, mast.y);
  ctx.lineTo(mast.x + wf.x * (L / 3), mast.y + wf.y * (L / 3));  // 仕様1/12は小さすぎるため視認性優先で1/3
  ctx.strokeStyle = '#e23b3b';
  ctx.lineWidth = L * 0.05;
  ctx.stroke();

  // 舵（yellow）: 船尾を軸に動く
  const stern = P(-L * 0.5, 0);
  const ra = theta + Math.PI + rudderB;
  ctx.beginPath();
  ctx.moveTo(stern.x, stern.y);
  ctx.lineTo(stern.x + Math.cos(ra) * (L / 3), stern.y + Math.sin(ra) * (L / 3));
  ctx.strokeStyle = '#f1c40f';
  ctx.lineWidth = L * 0.06;
  ctx.stroke();
}

function renderMinimap() {
  const size = 150;
  mini.width = Math.round(size * dpr); mini.height = Math.round(size * dpr);
  mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mctx.clearRect(0, 0, size, size);
  if (!stage) return;

  // 自船を中心に固定し、船首を上に向けて島の方を回転させる
  const cx = size / 2, cy = size / 2;
  const VR = R_WORLD + 40;                 // 表示範囲（自船中心）
  const sc = (size / 2 - 6) / VR;
  const Rm = -Math.PI / 2 - theta;          // 船首→上 の回転
  const cosR = Math.cos(Rm), sinR = Math.sin(Rm);
  const edge = size / 2 - 5;
  const plot = (wx, wy) => {
    const ox = wx - pos.x, oy = wy - pos.y;
    let px = (ox * cosR - oy * sinR) * sc;
    let py = (ox * sinR + oy * cosR) * sc;
    const d = Math.hypot(px, py);
    if (d > edge) { px = px / d * edge; py = py / d * edge; } // 範囲外は縁に寄せる
    return { x: cx + px, y: cy + py };
  };

  const wf = windAt(stage, time);
  const flagRight = Math.cos(wf.dir + Rm) >= 0;   // ミニマップの向きに合わせた左右判定
  for (const isl of stage.islands) {
    const q = plot(isl.x, isl.y);
    mctx.beginPath();
    mctx.arc(q.x, q.y, Math.max(2, isl.r * sc), 0, Math.PI * 2);
    mctx.fillStyle = '#3ad05a';                    // 訪問後も色は変えない
    mctx.fill();
    if (isl.visited) drawFlag(mctx, q.x, q.y, flagRight, 0.42);  // 小さな赤い旗
  }
  // 進行方向の曲線（白点線）
  const pts = pathPoints();
  if (pts) {
    mctx.strokeStyle = '#ffffff';
    mctx.lineWidth = 1.5;
    mctx.lineCap = 'round';
    mctx.setLineDash([3, 3]);
    mctx.beginPath();
    const a = plot(pts[0].x, pts[0].y);
    mctx.moveTo(a.x, a.y);
    for (let i = 1; i < pts.length; i++) { const q = plot(pts[i].x, pts[i].y); mctx.lineTo(q.x, q.y); }
    mctx.stroke();
    mctx.setLineDash([]);
  }

  // 自船（中央・常に上向き）
  mctx.save();
  mctx.translate(cx, cy);
  mctx.beginPath();
  mctx.moveTo(0, -6); mctx.lineTo(4, 5); mctx.lineTo(-4, 5); mctx.closePath();
  mctx.fillStyle = '#ffd24a';
  mctx.fill();
  mctx.restore();
}

/* ----------------------------- HUD ------------------------------------ */
const elTimer = document.getElementById('timer');
const elRemain = document.getElementById('remain');
function updateHud() {
  document.getElementById('side-btn').style.display = (state === 'play') ? 'flex' : 'none';
  const show = state === 'play' || state === 'clear';
  document.getElementById('hud').style.visibility = show ? 'visible' : 'hidden';
  if (!show) return;
  elTimer.textContent = fmt(time);
  elRemain.textContent = `島 ${visitedCount} / ${NUM_ISLANDS}`;
}

/* ----------------------------- 入力 ----------------------------------- */
let drag = null;
// サイドチェンジ＝視点を180°反転。facing を反転し、視点回転の目標へ +π を足して
// アニメーションで滑らかに回す（船・島・波・進路がまとめて回転。進路 θ・速度 v は不変）
function flip() { facing *= -1; viewTarget += Math.PI; updateMinimapSide(); }

// 現在の視点回転（背景・船・進路すべてに使う共通の回転）
function viewR() { return -theta + viewRot; }

// ミニマップの位置：船首が右なら右下、左なら左下
function updateMinimapSide() {
  if (facing > 0) { mini.style.left = 'auto'; mini.style.right = '10px'; }
  else { mini.style.right = 'auto'; mini.style.left = '10px'; }
}

canvas.addEventListener('pointerdown', (e) => {
  if (state !== 'play') return;
  const W = window.innerWidth;
  const x = e.clientX, y = e.clientY;
  const bowRight = facing > 0;
  const onRight = x > W * 0.5;
  const isSail = (onRight === bowRight);            // 船首側＝メインシート、船尾側＝舵
  drag = { mode: isSail ? 'sail' : 'rudder', startY: y, startVal: isSail ? sailA : rudderB, id: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const range = window.innerHeight * 0.4;
  const dy = e.clientY - drag.startY;
  if (drag.mode === 'sail') {
    // 上ドラッグ(dy<0)で帆を開く
    sailA = clamp(drag.startVal + (-dy) / range * SAIL_MAX, 0, SAIL_MAX);
  } else {
    // 舵は上下が逆（下ドラッグで＋）
    rudderB = clamp(drag.startVal + (dy) / range * RUDDER_MAX, -RUDDER_MAX, RUDDER_MAX);
  }
});

function endDrag(e) { if (drag && e.pointerId === drag.id) drag = null; }
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

/* --------------------------- メニュー / 画面 -------------------------- */
function show(id, on) { document.getElementById(id).classList.toggle('hidden', !on); }

document.getElementById('side-btn').addEventListener('click', () => { if (state === 'play') flip(); });
document.getElementById('menu-btn').addEventListener('click', () => {
  document.getElementById('menu').classList.toggle('hidden');
});
document.getElementById('help-btn').addEventListener('click', () => {
  show('menu', false); show('help', true);
});
document.getElementById('help-close').addEventListener('click', () => show('help', false));
document.getElementById('next-btn').addEventListener('click', () => startStage(Math.min(NUM_STAGES, stageNum + 1)));
document.getElementById('select-btn').addEventListener('click', () => { state = 'select'; buildSelect(); show('clear', false); show('select', true); });

function buildSelect() {
  const list = document.getElementById('select-list');
  const bests = getBests();
  list.innerHTML = '';
  for (let n = 1; n <= NUM_STAGES; n++) {
    const b = document.createElement('button');
    b.className = 'stage-btn';
    b.innerHTML = `<div class="no">${n}</div><div class="best">${bests[n] != null ? fmt(bests[n]) : '--:--.--'}</div>`;
    b.addEventListener('click', () => startStage(n));
    list.appendChild(b);
  }
}

/* ----------------------------- ループ --------------------------------- */
let last = null;
function frame(ts) {
  if (last == null) last = ts;
  let dt = (ts - last) / 1000;
  last = ts;
  dt = Math.min(dt, 0.05);
  if (state === 'play') update(dt);
  render();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => { dpr = Math.min(window.devicePixelRatio || 1, 2); });

buildSelect();
requestAnimationFrame(frame);
