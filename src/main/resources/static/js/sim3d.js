// 3D レースシミュレーション (three.js)
// 着順と各馬の「出来」は呼び出し側 (Zig wasm) が決め、ここでは走りを映像にする。

// しくみの概要:
//   1. setup()  … コース・建物・出走馬 (3D モデル) を作り、各馬の「走破タイム T」を決める
//   2. start()  … 時計を動かす
//   3. frame()  … 毎フレーム (1 秒に約 60 回) 呼ばれ、時刻 t における各馬の位置を計算して描画する
// 各馬の位置は「物理シミュレーション」ではなく、ゴール時刻 T から逆算した数式 (progress) で決める。
// これにより、Zig が決めた着順どおりに必ずゴールし、途中の展開 (逃げ・追込) も表現できる。
//
// "three" は index.html の importmap で /static/vendor/three.module.min.js を指している。
import * as THREE from "three";
import { GLTFLoader } from "/static/vendor/GLTFLoader.js";
import { clone as cloneSkinned } from "/static/vendor/SkeletonUtils.js";
import { OrbitControls } from "/static/vendor/OrbitControls.js";
import { coatOf, margin } from "./util.js";
import { makeJockey, makeSaddle, makeLabel } from "./jockey.js";

// 距離の単位はすべて「メートル」。3D 空間の 1 単位 = 1m として扱う。
const TRACK_W = 24; // コース幅 (m)
const HORSE_LEN = 2.5; // 馬の体長 (m)
// 脚質ごとの「前半の前への出方」。正なら序盤に前へ行き (逃げ・先行)、負なら序盤は後ろにいて終盤に伸びる。
// progress() の式 u + shape * u * (1 - u) の shape に使う。
const STYLE_SHAPE = [0.14, 0.07, -0.05, -0.12]; // 逃げ・先行・差し・追込: 序盤にどれだけ前へ行くか

/** スタジアム型 (直線2本 + 半円2つ) のコース。s = 1周の中での位置 (m) */
// --- コースの形 ---
// 実際の競馬場は複雑な形だが、ここでは「直線 2 本 + 半円 2 つ」の陸上トラック型で近似する。
//   S = 直線の長さ (競馬場ごとの「最後の直線」の値)
//   R = コーナーの半径 (直線が長い競馬場ほど少し大きく: 110 + 0.1 * S)
//   L = 1 周の長さ = 2S + 2πR
// s (0〜L) は「1 周の中の位置」、off は「内ラチから外へ何 m か」。
// 上から見た配置 (左回りの場合):
//     ┌──── 向こう正面 (z = -R) ← ────┐
//     ↓                                ↑   ← 右のコーナー中心 (S/2, 0)
//     └──── ホームストレッチ (z = +R) → ┘     ゴールはここ (スタンド側)
// 右回りの競馬場は x 座標を反転 (mirror = -1) して作る。
// ばんえい (帯広) は直線コースだけ (straightOnly)。
class Track {
  constructor(straight, turn) {
    this.straightOnly = turn === "直線";
    this.S = Math.max(200, straight);
    this.R = this.straightOnly ? 0 : 110 + 0.1 * this.S;
    this.L = this.straightOnly ? Infinity : 2 * this.S + 2 * Math.PI * this.R;
    this.mirror = turn === "右" ? -1 : 1; // 右回りは左右反転
    this.finish = this.straightOnly ? this.S * 0.9 : this.S * 0.85;
  }
  /** 位置 s、内ラチからの距離 off における座標と進行方向 */
  // 位置 s・内ラチから off m の点の座標 (x, z) と、進行方向の単位ベクトル (dx, dz) を返す。
  // s を L で割った余りにするので、1 周以上の距離 (3000m など) でも同じ式で扱える。
  //   0 ≤ s < S        : ホームストレッチ (+x 方向へ進む)
  //   S ≤ s < S+πR     : 1・2 コーナー (角度 p を 90° から -90° へ減らしながら半円を描く)
  //   S+πR ≤ s < 2S+πR : 向こう正面 (-x 方向)
  //   それ以降          : 3・4 コーナー
  // 半円上の点は (中心 + r·cos p, r·sin p)、進行方向はその接線 (sin p, -cos p)。
  at(s, off) {
    const { S, R, mirror } = this;
    let x, z, dx, dz;
    if (this.straightOnly) {
      x = -S / 2 + s;
      z = off;
      dx = 1;
      dz = 0;
    } else {
      s = ((s % this.L) + this.L) % this.L;
      const r = R + off;
      if (s < S) {
        x = -S / 2 + s;
        z = r;
        dx = 1;
        dz = 0;
      } else if (s < S + Math.PI * R) {
        const p = Math.PI / 2 - (s - S) / R;
        x = S / 2 + r * Math.cos(p);
        z = r * Math.sin(p);
        dx = Math.sin(p);
        dz = -Math.cos(p);
      } else if (s < 2 * S + Math.PI * R) {
        const u = s - (S + Math.PI * R);
        x = S / 2 - u;
        z = -r;
        dx = -1;
        dz = 0;
      } else {
        const p = -Math.PI / 2 - (s - (2 * S + Math.PI * R)) / R;
        x = -S / 2 + r * Math.cos(p);
        z = r * Math.sin(p);
        dx = Math.sin(p);
        dz = -Math.cos(p);
      }
    }
    return { x: x * mirror, z, dx: dx * mirror, dz };
  }
  /** 外向きの法線 (スタンド側) */
  // off を 0 → 1 に変えた 2 点の差 = コースの外側 (スタンド側) を向く単位ベクトル。
  // カメラや建物をコースの外側に置くのに使う。
  outward(s) {
    const a = this.at(s, 0),
      b = this.at(s, 1);
    return new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();
  }
}

// 空のグラデーション。縦長の小さなキャンバスに色を塗り、scene.background に貼る。
function gradientTexture(stops) {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d"),
    grad = g.createLinearGradient(0, 0, 0, 256);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 芝の刈り目 / ダートの砂目 */
// 芝の刈り目 (縞模様) とダートの砂粒を、画像ファイルを使わずキャンバスに描いて作る。
// RepeatWrapping で走路全体に繰り返し貼る。anisotropy は斜めから見たときのぼやけを減らす設定。
function surfaceTexture(dirt) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  if (dirt) {
    g.fillStyle = "#a27c56";
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 4000; i++) {
      g.fillStyle = `rgba(${Math.random() < 0.5 ? "70,50,30" : "200,170,130"},${Math.random() * 0.25})`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
    }
  } else {
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? "#5b9442" : "#66a14b";
      g.fillRect(0, i * 32, 256, 32);
    }
    for (let i = 0; i < 3000; i++) {
      g.fillStyle = `rgba(30,60,20,${Math.random() * 0.18})`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** ローカル +x 軸を水平ベクトル v に向ける Y 回転角 */
// 例: v = (0, 0, 1) (奥向き) → 回転角 -90°。ゴール線や発馬機を「コースを横切る向き」に置くのに使う。
const alongX = (v) => Math.atan2(-v.z, v.x);

// --- 3D シミュレーション本体。main.js から new RaceSim(canvas, コールバック) で使う ---
// コールバック:
//   onFrame(順位・残り距離・経過時間) … 毎フレーム。順位表 (HUD) の更新に使う
//   onFinish(結果)                    … 全頭がゴールしたとき 1 回
//   onLost()                          … GPU の都合で描画が続けられなくなったとき
export class RaceSim {
  constructor(canvas, { onFrame, onFinish, onReady, onLost } = {}) {
    this.labelMode = "name"; // 頭上の名札: name (馬番と馬名) / num (馬番だけ) / off
    this.canvas = canvas;
    this.onFrame = onFrame;
    this.onFinish = onFinish;
    this.onReady = onReady;
    this.onLost = onLost;
    this.speed = 1;
    this.camMode = "broadcast";
    this.running = false;
    this.visible = false;
    this.horses = [];
    this.clock = new THREE.Clock(false);
    this.t = 0;
    this.camPos = new THREE.Vector3(0, 60, 120);
    this.camLook = new THREE.Vector3();
  }

  // three.js の準備。WebGL が使えない環境では例外になり、main.js 側でメッセージを表示する。
  //   - setPixelRatio を最大 2 に制限: 高解像度ディスプレイで描画が重くなりすぎないように
  //   - PCFSoftShadowMap: 影の輪郭をやわらかくする
  //   - ACESFilmic: 映画のような明暗の付け方 (明るい空が白飛びしにくい)
  async init() {
    const r = (this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: "high-performance",
    }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.onLost?.();
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 6000);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.48;

    // 光は 2 つ: 空からの環境光 (Hemisphere: 上は空色、下は芝の色) + 太陽 (Directional、影を落とす)。
    // 影を描く範囲 (shadow.camera) は ±70m に絞り、カメラが見ている場所に毎フレーム追従させる
    // (コース全体 2km を影の範囲にすると、影の解像度が粗くなりすぎるため)。
    this.hemi = new THREE.HemisphereLight(0xdfeaf5, 0x4d5e35, 1.2);
    this.sun = new THREE.DirectionalLight(0xfff3df, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, {
      left: -70,
      right: 70,
      top: 70,
      bottom: -70,
      near: 1,
      far: 500,
    });
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    // 馬の 3D モデル (Quaternius 作、CC0)。アニメーション Gallop (駆け足) と Idle (待機) を含む。
    // モデルの大きさは作者によってまちまちなので、実寸 (体長 2.5m) になるよう縮尺を計算する。
    const gltf = await new GLTFLoader().loadAsync("/static/models/horse.glb");
    this.horseProto = gltf.scene;
    this.gallop = gltf.animations.find((a) => a.name === "Gallop");
    this.idle = gltf.animations.find((a) => a.name === "Idle");
    const box = new THREE.Box3().setFromObject(this.horseProto);
    const size = box.getSize(new THREE.Vector3());
    this.protoScale = HORSE_LEN / Math.max(size.x, size.z);
    this.protoAlongX = size.x > size.z; // モデルの前後方向
    this.horseHeight = size.y * this.protoScale;
    this.horseHalfWidth = (Math.min(size.x, size.z) * this.protoScale) / 2; // 胴の半分の幅 (騎手の脚・ゼッケンの位置)
    this.horseProto.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });

    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    this.resize();
    this.applyTheme();
    this.renderer.setAnimationLoop(() => this.frame());
    this.onReady?.();
  }

  // 表示領域の大きさが変わったら (ウィンドウのサイズ変更、スマホの回転など) 描画サイズを合わせる。
  resize() {
    if (!this.renderer) return;
    const el = this.canvas.parentElement;
    const w = el.clientWidth,
      h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // 空・霧・光の色と明るさをテーマに合わせて切り替える。照明塔とスタンドの窓は夜だけ光らせる。
  /** ダークテーマはナイター (夜の照明) として描く */
  applyTheme() {
    if (!this.scene) return;
    const night = document.documentElement.dataset.theme === "dark";
    this.night = night;
    this.scene.background = gradientTexture(
      night
        ? [
            [0, "#05080f"],
            [0.6, "#101a2b"],
            [1, "#22324a"],
          ]
        : [
            [0, "#7fa9d6"],
            [0.65, "#c9dcec"],
            [1, "#eef2f4"],
          ],
    );
    this.scene.fog = new THREE.Fog(night ? 0x101a2b : 0xd9e5ee, 500, 2600);
    this.hemi.color.set(night ? 0x8fa6c8 : 0xdfeaf5);
    this.hemi.groundColor.set(night ? 0x1a2414 : 0x4d5e35);
    this.hemi.intensity = night ? 0.55 : 1.2;
    this.sun.color.set(night ? 0xdfe8ff : 0xfff3df);
    this.sun.intensity = night ? 2.0 : 2.6;
    this.renderer.toneMappingExposure = night ? 1.15 : 1.0;
    this.lampMat?.emissive.set(night ? 0xfff6e0 : 0x333333);
    this.windowMat?.emissive.set(night ? 0x6d5a3a : 0x000000);
  }

  // scores は Zig (race_once) が計算した各馬の「その日の出来」。大きいほど速い。
  // 同じ opts で setup をやり直すと、まったく同じレースを再現できる (リプレイ)。
  /** コースと出走馬を作る。field: [{name, coat, waku, style, score}] */
  setup(opts) {
    const { course, distance, surface, field, scores } = opts;
    this.lastSetup = opts;
    this.stop();
    if (this.world) {
      this.scene.remove(this.world);
      this.world.traverse((o) => {
        o.geometry?.dispose();
      });
    }
    this.horses.forEach((h) => this.scene.remove(h.root));
    this.horses = [];
    this.world = new THREE.Group();
    this.scene.add(this.world);

    const isBanei = course.category === "ばんえい";
    const track = (this.track = new Track(
      course.straightMeters,
      isBanei ? "直線" : course.turn,
    ));
    this.distance = isBanei ? 200 : distance;
    this.course = course;
    this.dirt = isBanei || surface === "ダート";
    this.startS = track.finish - this.distance;
    this.buildWorld();

    // 着順の秒差: 出来 (score) の差を走破タイムに換算
    // 平均速度 (m/秒) の目安: 芝 2000m を約 2 分で走る ≒ 16.6 m/s。ダートは少し遅く、ばんえいはとても遅い。
    // 各馬の走破タイム T = 基準タイム × (1 + (1 着の出来 − その馬の出来) × 0.12)。
    // 0.12 は「着差が現実的な範囲 (数馬身) に収まる」ように調整した係数。
    const vAvg = isBanei ? 1.7 : this.dirt ? 15.9 : 16.6;
    const base = this.distance / vAvg;
    const best = Math.max(...scores);
    field.forEach((f, i) => {
      // 骨格アニメーション付きのモデルは普通の clone() では骨が共有されてしまうため、SkeletonUtils の clone を使う。
      // マテリアルも 1 頭ずつ複製してから毛色を塗る (共有したままだと全頭が同じ色になる)。
      const root = cloneSkinned(this.horseProto);
      root.scale.setScalar(this.protoScale);
      const [body, dark, light, hair] = coatOf(f.coat);
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        const n = o.material.name;
        if (n === "Main") o.material.color.set(body);
        else if (n === "Main_Dark") o.material.color.set(dark);
        else if (n === "Main_Light") o.material.color.set(light);
        else if (n === "Hair") o.material.color.set(hair);
        o.material.roughness = 0.55;
      });
      // holder (入れ物) に「馬」と「騎手」を入れ、位置と向きは holder ごと動かす。
      // モデルの前後が x 軸向きなら 90° 回して、holder の +z (進行方向) に合わせる。
      const holder = new THREE.Group();
      holder.add(root);
      if (this.protoAlongX) root.rotation.y = -Math.PI / 2;
      // children[1] = 騎手 (走るときに弾ませる)、children[2] = 鞍とゼッケン (馬と一緒に動く)
      const seat = new THREE.Vector3(0, this.horseHeight * 0.72, 0.15);
      const jockey = makeJockey({ cap: f.silk, name: f.name, halfWidth: this.horseHalfWidth * 0.85 });
      jockey.position.copy(seat);
      const saddle = makeSaddle({ num: f.num, halfWidth: this.horseHalfWidth * 0.85 });
      saddle.position.copy(seat);
      // children[3], [4] = 頭上の名札 (馬番と馬名 / 馬番だけ)。どちらを出すかは labelMode
      const labels = [makeLabel({ num: f.num, name: f.name, color: f.silk }), makeLabel({ num: f.num, color: f.silk })];
      labels.forEach((l) => { l.position.set(0, this.horseHeight + 1.0, 0); l.visible = l.userData.label === this.labelMode; });
      holder.add(jockey, saddle, ...labels);
      // AnimationMixer: モデルのアニメーションを再生する仕組み。発走前は Idle、スタートで Gallop に切り替える。
      // 再生位置を馬ごとにずらし (Math.random)、全頭の脚がそろって動く不自然さを避ける。
      const mixer = new THREE.AnimationMixer(root);
      const act = mixer.clipAction(this.gallop);
      act.time = Math.random() * this.gallop.duration;
      const idle = this.idle ? mixer.clipAction(this.idle) : null;
      if (idle) {
        idle.time = Math.random() * this.idle.duration;
        idle.play();
      } else act.play();
      this.scene.add(holder);
      const T = base * (1 + (best - scores[i]) * 0.12);
      this.horses.push({
        ...f,
        root: holder,
        mixer,
        act,
        idle,
        index: i,
        T,
        shape: STYLE_SHAPE[f.style] ?? 0,
        // lane = 内ラチからの距離。発走時は馬番順に約 1.35m 間隔で横に並ぶ (発馬機のゲート幅)。
        lane:
          1.2 + i * (Math.min(TRACK_W - 3, 1.35 * field.length) / field.length),
        s: this.startS,
        v: 0,
        finished: false,
        finishT: null,
        phase: Math.random() * 6,
      });
    });
    this.t = 0;
    this.finished = false;
    this.placeHorses(0);
    const mid = track.at(this.startS, TRACK_W / 2);
    const out = track.outward(this.startS);
    this.camLook.set(mid.x, 1.5, mid.z);
    this.camPos.set(
      mid.x + out.x * 36 - mid.dx * 18,
      9,
      mid.z + out.z * 36 - mid.dz * 18,
    );
  }

  // コース周りの景色を作る: 芝生の地面 → 走路 → ラチ → ハロン棒・ゴール板 → スタンド → 照明塔・木 → 大型ビジョン → 発馬機。
  // 同じ形をたくさん置くもの (ラチの支柱、木) は InstancedMesh で 1 回の描画命令にまとめて軽くしている。
  buildWorld() {
    const W = this.world,
      tr = this.track;
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(8000, 8000),
      new THREE.MeshStandardMaterial({
        color: this.night ? 0x2a3d22 : 0x5c7d43,
        roughness: 1,
      }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.05;
    grass.receiveShadow = true;
    W.add(grass);

    // 走路
    const tex = surfaceTexture(this.dirt);
    // 走路は 2m ごとに「内側の点」と「外側の点」を置き、隣どうしを三角形 2 枚でつないだ帯 (リボン) として作る。
    // 法線はすべて真上 (0, 1, 0) にする (平らな地面なので計算不要。右回りで裏返っても暗くならない)。
    const pos = [],
      uv = [],
      idx = [];
    const total = tr.straightOnly ? tr.S + 40 : tr.L;
    const step = 2,
      n = Math.ceil(total / step);
    for (let i = 0; i <= n; i++) {
      const s = (tr.straightOnly ? -20 : 0) + i * step;
      const a = tr.at(s, -1),
        b = tr.at(s, TRACK_W + 1);
      pos.push(a.x, 0, a.z, b.x, 0, b.z);
      uv.push(s / 16, 0, s / 16, (TRACK_W + 2) / 16);
      if (i < n) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(
        pos.map((_, i) => (i % 3 === 1 ? 1 : 0)),
        3,
      ),
    );
    const road = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.95,
        side: THREE.DoubleSide,
      }),
    );
    road.receiveShadow = true;
    W.add(road);

    // ラチ (白い柵): 支柱をインスタンス描画、手すりはチューブ
    const railMat = new THREE.MeshStandardMaterial({
      color: 0xf4f4f2,
      roughness: 0.4,
    });
    for (const off of [-0.6, TRACK_W + 0.6]) {
      const pts = [];
      const span = tr.straightOnly ? tr.S + 40 : tr.L;
      for (let s = 0; s <= span; s += 6) {
        const p = tr.at((tr.straightOnly ? -20 : 0) + s, off);
        pts.push(new THREE.Vector3(p.x, 1.05, p.z));
      }
      const curve = new THREE.CatmullRomCurve3(pts, !tr.straightOnly);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(
          curve,
          pts.length * 2,
          0.07,
          6,
          !tr.straightOnly,
        ),
        railMat,
      );
      tube.castShadow = true;
      W.add(tube);
      const posts = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.08, 1.05, 0.08),
        railMat,
        pts.length,
      );
      const m = new THREE.Matrix4();
      pts.forEach((p, i) => {
        m.makeTranslation(p.x, 0.52, p.z);
        posts.setMatrixAt(i, m);
      });
      W.add(posts);
    }

    // ハロン棒 (ゴールから 200m ごと) とゴール板
    const red = new THREE.MeshStandardMaterial({
      color: 0xc8302a,
      roughness: 0.5,
    });
    const white = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.5,
    });
    // ハロン棒 = ゴールまでの残り距離を示す柱。200m ごとに立て、400m ごとに赤くする。
    for (let d = 200; d < Math.min(this.distance, 2000); d += 200) {
      const p = tr.at(tr.finish - d, -1.2);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 3, 8),
        d % 400 ? white : red,
      );
      pole.position.set(p.x, 1.5, p.z);
      W.add(pole);
    }
    const fp = tr.at(tr.finish, -1.5);
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 6, 10),
      white,
    );
    post.position.set(fp.x, 3, fp.z);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 0.9, 0.08, 32),
      red,
    );
    disc.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      tr.outward(tr.finish),
    );
    disc.position.set(fp.x, 5.6, fp.z);
    W.add(post, disc);
    const lineA = tr.at(tr.finish, 0),
      lineB = tr.at(tr.finish, TRACK_W);
    const line = new THREE.Mesh(
      new THREE.BoxGeometry(TRACK_W, 0.02, 0.35),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    line.rotation.y = alongX(tr.outward(tr.finish));
    line.position.set((lineA.x + lineB.x) / 2, 0.02, (lineA.z + lineB.z) / 2);
    W.add(line);

    // スタンド (ホームストレッチの外側)
    // スタンドはホームストレッチの外側、外ラチから約 58m の位置。4 段の箱を少しずつ奥へずらして階段状にする。
    // lookAt で「上の段ほどコースから遠い」向きにそろえる。
    const standLen = Math.min(tr.S * 0.8, 420);
    const mid = tr.at(tr.finish - standLen * 0.35, TRACK_W + 58);
    const stand = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({
      color: this.night ? 0x8a8e94 : 0xd9dbde,
      roughness: 0.85,
    });
    this.windowMat = new THREE.MeshStandardMaterial({
      color: 0x2c3742,
      roughness: 0.25,
      metalness: 0.3,
      emissive: this.night ? 0x6d5a3a : 0x000000,
    });
    for (let k = 0; k < 4; k++) {
      const tier = new THREE.Mesh(
        new THREE.BoxGeometry(standLen, 5, 12),
        k === 3 ? this.windowMat : concrete,
      );
      tier.position.set(0, 2.5 + k * 5, k * 7);
      tier.castShadow = tier.receiveShadow = true;
      stand.add(tier);
    }
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(standLen + 10, 1, 34),
      concrete,
    );
    roof.position.set(0, 23, 14);
    roof.castShadow = true;
    stand.add(roof);
    stand.position.set(mid.x, 0, mid.z);
    stand.lookAt(stand.position.clone().add(tr.outward(tr.finish))); // 上段ほど外側 (+z) に
    W.add(stand);

    // 照明塔 (ナイターで発光) と木々
    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: this.night ? 0xfff6e0 : 0x333333,
      emissiveIntensity: 1.5,
    });
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x6b7079,
      roughness: 0.6,
    });
    const treeMat = new THREE.MeshStandardMaterial({
      color: this.night ? 0x1f3320 : 0x3f6b3a,
      roughness: 1,
    });
    const span = tr.straightOnly ? tr.S : tr.L;
    for (let s = 0; s < span; s += span / 10) {
      const p = tr.at(s, TRACK_W + 14);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.6, 36, 8),
        poleMat,
      );
      pole.position.set(p.x, 18, p.z);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), this.lampMat);
      lamp.position.set(p.x, 36, p.z);
      lamp.lookAt(0, 0, 0);
      W.add(pole, lamp);
    }
    const trees = new THREE.InstancedMesh(
      new THREE.ConeGeometry(4, 12, 7),
      treeMat,
      160,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < 160; i++) {
      const s = Math.random() * (tr.straightOnly ? tr.S : tr.L);
      const p = tr.at(s, TRACK_W + 70 + Math.random() * 160);
      const sc = 0.7 + Math.random() * 0.9;
      m.compose(
        new THREE.Vector3(p.x, 6 * sc, p.z),
        new THREE.Quaternion(),
        new THREE.Vector3(sc, sc, sc),
      );
      trees.setMatrixAt(i, m);
    }
    trees.castShadow = true;
    W.add(trees);

    // 内馬場の大型ビジョン
    if (!tr.straightOnly) {
      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(60, 18, 1.5),
        new THREE.MeshStandardMaterial({
          color: 0x15181c,
          emissive: this.night ? 0x1d2a3a : 0x0a0d10,
          roughness: 0.3,
        }),
      );
      const sp = tr.at(tr.finish - tr.S * 0.4, -55);
      screen.position.set(sp.x, 14, sp.z);
      screen.lookAt(
        tr.at(tr.finish - tr.S * 0.4, TRACK_W + 40).x,
        14,
        tr.at(tr.finish - tr.S * 0.4, TRACK_W + 40).z,
      );
      W.add(screen);
    }

    // 発馬機
    // 発馬機: 18 枠分の仕切り・脚・屋根。スタート地点に、コースを横切る向きで置く。
    const gateMat = new THREE.MeshStandardMaterial({
      color: 0x3d8a5d,
      roughness: 0.5,
      metalness: 0.2,
    });
    const gate = new THREE.Group();
    for (let k = 0; k <= 18; k++) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.5, 3.0),
        gateMat,
      );
      bar.position.set(k * 1.35, 2.75, 0);
      gate.add(bar);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3, 0.1), gateMat);
      leg.position.set(k * 1.35, 1.5, 1.45);
      gate.add(leg, leg.clone().translateZ(-2.9));
      gate.add(bar);
    }
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(18 * 1.35, 0.4, 3.4),
      gateMat,
    );
    top.position.set(9 * 1.35, 3, 0);
    gate.add(top);
    const start = tr.finish - this.distance;
    const gp = tr.at(start + 0.3, 0.4);
    gate.position.set(gp.x, 0, gp.z);
    gate.rotation.y = alongX(tr.outward(start));
    gate.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    W.add(gate);
  }

  // すでに走り終えている (または途中) なら、同じ条件で最初から作り直してから走らせる。
  // crossFadeTo: 待機アニメーションから駆け足へ 0.4 秒かけてなめらかに切り替える。
  start() {
    if (!this.horses.length || this.running) return;
    if (this.finished || this.t > 0) this.setup(this.lastSetup);
    for (const h of this.horses) {
      h.act.reset().play();
      if (h.idle) h.idle.crossFadeTo(h.act, 0.4, false);
    }
    this.running = true;
    this.clock.start();
  }
  stop() {
    this.running = false;
    this.clock.stop();
  }
  /** 頭上の名札: "name" (馬番と馬名) / "num" (馬番だけ) / "off" */
  setLabels(mode) {
    this.labelMode = mode;
    for (const h of this.horses) h.root.children.forEach((o) => { if (o.userData.label) o.visible = o.userData.label === mode; });
  }

  setSpeed(x) {
    this.speed = x;
  }
  setCamera(mode) {
    this.camMode = mode;
    if (!this.controls) return;
    this.controls.enabled = mode === "free";
    if (mode === "free") this.controls.target.copy(this.camLook);
  }
  setVisible(v) {
    this.visible = v;
    if (v) this.resize();
  }

  // スタートからの経過時刻 t → スタートからの走行距離 (m)。
  //   1. tw = t − acc·(1 − e^(−t/acc))
  //      … 発走直後は速度 0 から約 2 秒かけて加速する「時間の遅れ」を表す (acc = 1.1 秒)
  //   2. u = tw / (T − acc)  … 0 (スタート) 〜 1 (ゴール) の進み具合。ちょうど時刻 T で 1 になる
  //   3. 距離 = D × (u + shape·u·(1 − u))
  //      … shape > 0 なら序盤に前へ (逃げ)、shape < 0 なら序盤は後ろで終盤に伸びる (追込)。
  //         u = 0 と u = 1 では shape に関係なく 0 と D になるので、ゴール時刻は必ず T。
  // ゴール後は 5 秒ほどかけて指数関数的に減速する。
  /** 時刻 t における位置 (m)。スタート直後は 0 から加速 */
  progress(h, t) {
    const acc = 1.1;
    const tw = t - acc * (1 - Math.exp(-t / acc));
    const u = tw / (h.T - acc);
    if (u < 1) return this.distance * (u + h.shape * u * (1 - u));
    // ゴール後はゆっくり減速
    const vEnd = (this.distance * (1 - h.shape)) / (h.T - acc);
    const dt = (u - 1) * (h.T - acc);
    return this.distance + vEnd * 5 * (1 - Math.exp(-dt / 5));
  }

  // 各馬の横位置 (レーン) を決めて、3D 空間に配置する。
  // 前を走る馬から順に「すぐ前後 (体長の 1.15 倍以内) にいる馬と横に重ならないレーン」を探し、
  // 重なるなら 1.3m ずつ外へずらす。実際の馬もなるべく内ラチ沿い (1.0m) を走ろうとする。
  // レーンの変更は dt に比例して少しずつ (急に横へ瞬間移動しないように)。
  // 向きは進行方向 (dx, dz) から atan2 で求める。
  placeHorses(dt) {
    const tr = this.track;
    // 前の馬から順に、重ならないレーンを選ぶ
    const order = [...this.horses].sort((a, b) => b.s - a.s);
    const placed = [];
    for (const h of order) {
      let want = h.started ? 1.0 : h.lane;
      if (h.started) {
        for (let tries = 0; tries < 20; tries++) {
          const clash = placed.some(
            (o) =>
              Math.abs(o.s - h.s) < HORSE_LEN * 1.15 &&
              Math.abs(o.lane - want) < 1.25,
          );
          if (!clash) break;
          want += 1.3;
        }
        want = Math.min(want, TRACK_W - 1.5);
        h.lane += (want - h.lane) * Math.min(1, dt * 1.6);
      }
      placed.push(h);
      const p = tr.at(h.s, h.lane);
      h.root.position.set(p.x, 0, p.z);
      h.root.rotation.y = Math.atan2(p.dx, p.dz);
    }
    return order;
  }

  // 毎フレームの処理 (renderer.setAnimationLoop から呼ばれる)。
  //   real = 実際に経過した秒数 (タブが裏に回っていた等で大きくなりすぎないよう最大 0.05 秒)
  //   dt   = レース内の経過秒数 = real × 再生速度 (1×/2×/4×)
  // シミュレーション画面が表示されていないときは何もしない (CPU / GPU を使わない)。
  frame() {
    if (!this.visible || !this.scene) return;
    const real = Math.min(this.clock.running ? this.clock.getDelta() : 0, 0.05);
    const dt = real * this.speed;
    if (this.running) this.t += dt;
    let order = this.horses;
    if (this.horses.length) {
      for (const h of this.horses) {
        h.started = this.running || this.t > 0;
        const prev = h.s;
        h.s = this.startS + (h.started ? this.progress(h, this.t) : 0);
        const v = dt > 0 ? (h.s - prev) / dt : 0;
        h.v += (v - h.v) * 0.2;
        // 脚の回転速度を実際の速度に合わせる (15 m/s で等速再生)。止まりそうでも 0.35 倍以下にはしない。
        h.act.timeScale = Math.max(0.35, h.v / 15);
        h.mixer.update(dt || 0);
        // 騎手を速度に合わせて上下に揺らし、馬の上で弾んでいるように見せる。
        h.phase += dt * h.v * 0.45;
        const j = h.root.children[1];
        if (j) {
          const run = Math.min(1, h.v / 10);
          j.position.y = this.horseHeight * 0.72 + Math.sin(h.phase) * 0.05 * run;
          // 腕は馬の首の動きに合わせて前後に (手綱を押す)。ゴール前 400m からは大きく
          const push = h.s > this.startS + this.distance - 400 && !h.finished ? 0.2 : 0.09;
          if (j.userData.arms) j.userData.arms.rotation.x = Math.sin(h.phase + 1.2) * push * run;
        }
        const goal = this.startS + this.distance;
        if (!h.finished && h.s >= goal) {
          h.finished = true;
          // フレームの間でゴール線を越えた瞬間を線形補間 (着差をフレーム間隔に左右させない)
          h.finishT =
            h.s > prev ? this.t - (dt * (h.s - goal)) / (h.s - prev) : this.t;
        }
      }
      order = this.placeHorses(dt);
      if (!this.finished && this.horses.every((h) => h.finished)) {
        this.finished = true;
        this.onFinish?.(this.results());
      }
      if (
        this.finished &&
        this.t > Math.max(...this.horses.map((h) => h.finishT)) + 6
      )
        this.stop();
    }
    this.updateCamera(order, real);
    if (this.camMode === "free") this.controls.update();
    this.renderer.render(this.scene, this.camera);
    // 表示順: ゴールした馬は到達順で固定し、その後ろに走行中の馬
    const shown = [
      ...this.horses
        .filter((h) => h.finished)
        .sort((a, b) => a.finishT - b.finishT),
      ...order.filter((h) => !h.finished),
    ];
    if (this.horses.length)
      this.onFrame?.({
        order: shown.map((h) => h.index),
        remain: Math.max(0, this.distance - (order[0].s - this.startS)),
        t: this.t,
      });
  }

  // カメラの位置を決める。先頭 6 頭の平均位置 (集団の中心) を基準にする。
  //   broadcast (中継) : 外ラチの外・高さ 13m から集団を横に追う (テレビ中継の構図)
  //   chase (追走)     : 先頭の馬の 14m 後ろ・高さ 4.5m から前方を見る
  //   aerial (俯瞰)    : 上空からコース全体を見下ろす
  //   free (自由)      : OrbitControls (ドラッグで回転) に任せ、注視点だけ集団に追従
  // 目標位置へは lerp (少しずつ近づける) で動かし、カメラが急に飛ばないようにする。
  // k = 1 − e^(−2.5·real) はフレームレートが変わっても同じ速さで追従するための係数。
  updateCamera(order, real) {
    if (!this.horses.length) return;
    const tr = this.track;
    const lead = order[0];
    const pack = order.slice(0, Math.min(6, order.length));
    const cs = pack.reduce((a, h) => a + h.s, 0) / pack.length;
    const c = tr.at(cs, 6);
    const look = new THREE.Vector3(c.x, 1.4, c.z);
    const out = tr.outward(cs);
    let pos;
    if (this.camMode === "chase") {
      const p = tr.at(lead.s, lead.lane);
      pos = new THREE.Vector3(
        p.x - p.dx * 14 + out.x * 4,
        4.5,
        p.z - p.dz * 14 + out.z * 4,
      );
      look.set(p.x + p.dx * 12, 1.5, p.z + p.dz * 12);
    } else if (this.camMode === "aerial") {
      pos = new THREE.Vector3(
        c.x * 0.4,
        Math.max(220, tr.S * 0.55),
        c.z * 0.4 + 260,
      );
    } else if (this.camMode === "free") {
      this.controls.target.lerp(look, 0.08);
      return;
    } else {
      // 中継カメラ: 外ラチの外、少し前から集団を横に追う
      const lens = Math.min(58, 40 + order.length * 1.2); // スタンド (外ラチから約 58m) より内側に置く
      pos = new THREE.Vector3(
        c.x + out.x * lens + c.dx * 10,
        13,
        c.z + out.z * lens + c.dz * 10,
      );
    }
    const k = 1 - Math.exp(-real * 2.5);
    this.camPos.lerp(pos, this.t === 0 ? 1 : k);
    this.camLook.lerp(look, this.t === 0 ? 1 : Math.min(1, k * 1.6));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.sun.position.set(this.camLook.x + 60, 120, this.camLook.z + 40);
    this.sun.target.position.copy(this.camLook);
  }

  // 着順 (ゴール時刻の早い順) と着差。着差 = 前の馬とのゴール時刻の差 × 1 着馬の平均速度 (m) を馬身に換算。
  results() {
    const sorted = [...this.horses].sort((a, b) => a.finishT - b.finishT);
    const v = this.distance / sorted[0].finishT;
    return sorted.map((h, i) => ({
      index: h.index,
      name: h.name,
      waku: h.waku,
      num: h.num,
      time: h.finishT,
      margin: i === 0 ? "" : margin((h.finishT - sorted[i - 1].finishT) * v),
    }));
  }
}
