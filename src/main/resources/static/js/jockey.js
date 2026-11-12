// ==================================================================================
// jockey.js — 3D シミュレーションの騎手・勝負服・鞍とゼッケン
// ==================================================================================
// 騎手は「関節の位置」を先に決め、その間を丸みのある棒 (カプセル) でつないで作る。
// 姿勢は、あぶみに立って上体を前に倒す「モンキー乗り」(日本の競馬の標準的な乗り方)。
//
// 座標: 原点 = 鞍の上 (馬の背)。x = 右、y = 上、z = 前 (馬の進む向き)。単位はメートル。
//
// 勝負服 (服の色と柄) は本来は馬主ごとに登録されたものだが、そのデータは持っていないので、
// 馬名から毎回同じ柄を自動で決める (同じ馬はいつも同じ服になる)。帽子の色は JRA と同じく枠の色。
import * as THREE from "three";

// JRA の勝負服に使える 13 色
const SILK_COLORS = ["#c8202a", "#f08bb0", "#f2c200", "#1d8a3a", "#1f4fb5", "#4fbde6", "#6a3d9a", "#b39ddb", "#7b4a2a", "#6b1f2a", "#8a8d91", "#1d1d1f", "#f4f4f4"];
// 胴の柄 (JRA の服色の柄の名前に近いもの)
const BODY_PATTERNS = ["無地", "一本輪", "三本輪", "縦縞", "襷", "山形", "菱", "格子", "霰"];
// 袖の柄
const SLEEVE_PATTERNS = ["同色", "別色", "袖輪", "元袖"];

/** 文字列 → 0 以上の整数 (同じ名前なら毎回同じ値) */
function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

/** 馬名から勝負服を決める: { base, accent, body, sleeve } */
export function silkOf(name) {
  const h = hash(name || "?");
  const base = SILK_COLORS[h % 13];
  let accent = SILK_COLORS[(h >>> 4) % 13];
  if (accent === base) accent = SILK_COLORS[(h % 13 + 6) % 13]; // 同じ色どうしにならないように
  return { base, accent, body: BODY_PATTERNS[(h >>> 9) % BODY_PATTERNS.length], sleeve: SLEEVE_PATTERNS[(h >>> 13) % SLEEVE_PATTERNS.length] };
}

// 柄を canvas に描いてテクスチャにする。カプセルの貼り方は u = ぐるりと一周、v = 下 (腰) → 上 (肩)。
function patternTexture(kind, base, accent) {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  g.fillStyle = accent;
  g.strokeStyle = accent;
  switch (kind) {
    case "一本輪": g.fillRect(0, S * 0.42, S, S * 0.18); break;
    case "三本輪": for (const y of [0.22, 0.45, 0.68]) g.fillRect(0, S * y, S, S * 0.1); break;
    case "縦縞": for (let x = 0; x < S; x += S / 8) g.fillRect(x, 0, S / 16, S); break;
    case "襷": // 肩から腰へ斜めにかける帯 (前後 2 本に見える)
      g.lineWidth = S * 0.12;
      for (const o of [0, S / 2]) { g.beginPath(); g.moveTo(o - S * 0.1, 0); g.lineTo(o + S * 0.35, S); g.stroke(); }
      break;
    case "山形":
      g.lineWidth = S * 0.09;
      for (const y of [0.35, 0.65]) {
        g.beginPath();
        for (let x = 0; x <= S; x += S / 4) g.lineTo(x, S * y + ((x / (S / 4)) % 2 ? -S * 0.08 : S * 0.08));
        g.stroke();
      }
      break;
    case "菱":
      for (let y = 0; y < S; y += S / 4) for (let x = 0; x < S; x += S / 4) {
        g.beginPath();
        g.moveTo(x + S / 8, y); g.lineTo(x + S / 4, y + S / 8); g.lineTo(x + S / 8, y + S / 4); g.lineTo(x, y + S / 8);
        g.fill();
      }
      break;
    case "格子":
      g.globalAlpha = 0.85;
      for (let i = 0; i < S; i += S / 6) { g.fillRect(i, 0, S / 24, S); g.fillRect(0, i, S, S / 24); }
      break;
    case "霰": // 水玉
      for (let y = S / 10; y < S; y += S / 5) for (let x = (y / (S / 5)) % 2 ? S / 10 : 0; x < S; x += S / 5) {
        g.beginPath(); g.arc(x, y, S / 22, 0, Math.PI * 2); g.fill();
      }
      break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 勝負服の生地: サテンのような柔らかい光沢 (sheen)
const silkMaterial = (map) => new THREE.MeshPhysicalMaterial({ map, roughness: 0.5, sheen: 0.8, sheenRoughness: 0.35, sheenColor: new THREE.Color("#ffffff") });

// 何度も使う材質と形は 1 つだけ作って共有する (18 頭分作ると重くなるため)
let shared = null;
function sharedParts() {
  if (shared) return shared;
  shared = {
    white: new THREE.MeshStandardMaterial({ color: "#f3f3f1", roughness: 0.75 }), // ズボン・手袋
    boot: new THREE.MeshPhysicalMaterial({ color: "#141414", roughness: 0.32, clearcoat: 0.6 }), // ブーツ (革)
    skin: new THREE.MeshStandardMaterial({ color: "#e0b495", roughness: 0.8 }),
    goggle: new THREE.MeshPhysicalMaterial({ color: "#1a1d22", roughness: 0.1, metalness: 0.3, clearcoat: 1 }),
    leather: new THREE.MeshStandardMaterial({ color: "#4a2c19", roughness: 0.55 }), // 鞍
    whip: new THREE.MeshStandardMaterial({ color: "#151515", roughness: 0.4 }),
    head: new THREE.SphereGeometry(0.088, 18, 14),
    cap: new THREE.SphereGeometry(0.103, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    visor: new THREE.CylinderGeometry(0.103, 0.103, 0.012, 20, 1, false, -0.9, 1.8),
    goggles: new THREE.BoxGeometry(0.15, 0.034, 0.05),
    hand: new THREE.SphereGeometry(0.042, 12, 10),
  };
  return shared;
}

/** 2 点 a・b の間をつなぐカプセル (腕・脚・胴に使う) */
function limb(a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - r), 6, 14), mat);
  m.position.copy(a).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  return m;
}
const v = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * 騎手を作る。cap = 帽子の色 (枠の色)、name = 馬名 (勝負服を決める)、halfWidth = 馬の胴の半分の幅。
 * 戻り値の userData.arms を、走っている間に前後に動かす (手綱を押す動き)。
 */
export function makeJockey({ cap, name, halfWidth = 0.28 }) {
  const P = sharedParts();
  const silk = silkOf(name);
  const g = new THREE.Group();
  const bodyMat = silkMaterial(patternTexture(silk.body, silk.base, silk.accent));
  const sleeveBase = silk.sleeve === "別色" ? silk.accent : silk.base;
  const sleeveMat = silkMaterial(patternTexture(silk.sleeve === "袖輪" ? "三本輪" : "無地", sleeveBase, silk.accent));
  const upperSleeveMat = silk.sleeve === "元袖" ? silkMaterial(patternTexture("無地", silk.accent, silk.accent)) : sleeveMat;
  const capMat = new THREE.MeshPhysicalMaterial({ color: cap, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2 });

  const legX = halfWidth + 0.05; // 脚は馬の胴の外側
  // 関節の位置 (あぶみに立ち、腰を浮かせて上体を前に倒した姿勢)
  const hip = v(0, 0.2, -0.06), chest = v(0, 0.42, 0.34);
  const torso = limb(hip, chest, 0.15, bodyMat);
  torso.scale.set(1.12, 1, 0.82); // 胴は少し平たく
  g.add(torso);

  // 頭: 顔 (肌) + 帽子 (半球とひさし) + ゴーグル。少し前を見下ろす向き
  const head = new THREE.Group();
  head.position.set(0, 0.53, 0.45);
  head.rotation.x = 0.35;
  const face = new THREE.Mesh(P.head, P.skin);
  const capTop = new THREE.Mesh(P.cap, capMat);
  capTop.position.y = 0.015;
  const visor = new THREE.Mesh(P.visor, capMat);
  visor.position.set(0, 0.012, 0.02);
  visor.scale.set(1.15, 1, 1.35);
  const goggles = new THREE.Mesh(P.goggles, P.goggle); // 顔の前を横切るゴーグル
  goggles.position.set(0, -0.005, 0.065);
  head.add(face, capTop, visor, goggles);
  head.traverse((o) => o.isMesh && (o.castShadow = true));
  g.add(head);

  // 腕 (肩 → ひじ → 手)。肩を中心に回せるよう、まとめて arms に入れる
  const arms = new THREE.Group();
  arms.position.copy(chest).add(v(0, 0.02, 0.0));
  g.add(arms);
  for (const sx of [-1, 1]) {
    const sh = v(sx * 0.15, 0, 0), el = v(sx * 0.2, -0.13, 0.15), hand = v(sx * 0.08, -0.2, 0.36);
    arms.add(limb(sh, el, 0.052, upperSleeveMat), limb(el, hand, 0.046, sleeveMat));
    const glove = new THREE.Mesh(P.hand, P.white);
    glove.position.copy(hand);
    glove.castShadow = true;
    arms.add(glove);
    if (sx === 1) {
      // 鞭: 右手から後ろ下へ
      const whip = limb(hand, hand.clone().add(v(0.04, -0.12, -0.55)), 0.008, P.whip);
      arms.add(whip);
    }
  }

  // 脚 (腰 → ひざ → 足首 → つま先)。太ももは白いズボン、すねから下は黒いブーツ
  for (const sx of [-1, 1]) {
    const h = v(sx * 0.1, 0.18, -0.06), knee = v(sx * legX, 0.08, 0.24), ankle = v(sx * (legX + 0.01), -0.16, 0.04), toe = v(sx * (legX + 0.01), -0.18, 0.14);
    g.add(limb(h, knee, 0.066, P.white), limb(knee, ankle, 0.05, P.boot), limb(ankle, toe, 0.042, P.boot));
  }

  g.scale.setScalar(0.88); // 馬 (体長 2.5m) に対する人の大きさ
  g.userData = { jockey: true, arms, silk };
  return g;
}

/**
 * 馬の頭上に出す名札: 枠の色の四角に馬番、その右に馬名 (name を省くと馬番だけ)。
 * 常にカメラの方を向く板 (Sprite) で、遠くても近くても画面上の大きさは同じ (sizeAttenuation: false)。
 * 前の馬に隠れないよう、深さの判定をせずに最後に描く (depthTest: false)。
 */
export function makeLabel({ num, name, color }) {
  const W = name ? 512 : 104, H = 112;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = "rgba(15, 18, 24, 0.78)";
  x.beginPath();
  x.roundRect(4, 8, W - 8, H - 16, 22);
  x.fill();
  x.fillStyle = color;
  x.beginPath();
  x.roundRect(14, 18, 76, H - 36, 14);
  x.fill();
  // 枠の色が明るい (白・黄など) なら黒い数字、暗いなら白い数字
  const [r, g, b] = new THREE.Color(color).toArray();
  x.fillStyle = 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? "#111" : "#fff";
  x.font = "bold 54px 'Helvetica Neue', Arial, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(String(num), 52, H / 2 + 2);
  if (name) {
    x.fillStyle = "#fff";
    x.textAlign = "left";
    x.font = "bold 48px 'Hiragino Sans', 'Noto Sans JP', sans-serif";
    x.fillText(name, 106, H / 2 + 2, W - 124);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  // 高さ 0.017 = 視野角 32° のカメラで画面の高さの約 3% (900px の画面で約 26px)
  sprite.scale.set((0.017 * W) / H, 0.017, 1);
  sprite.renderOrder = 10;
  sprite.userData.label = name ? "name" : "num";
  return sprite;
}

/** 鞍と、馬番を書いたゼッケン (馬の左右)。馬と一緒に動き、騎手のように弾まない */
export function makeSaddle({ num, halfWidth = 0.28 }) {
  const P = sharedParts();
  const g = new THREE.Group();
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(halfWidth * 1.3, 0.05, 0.5), P.leather);
  saddle.position.set(0, -0.03, 0.02);
  saddle.castShadow = true;
  g.add(saddle);
  // ゼッケン: 白地に黒い馬番
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 80;
  const x = c.getContext("2d");
  x.fillStyle = "#f7f7f5";
  x.fillRect(0, 0, 128, 80);
  x.fillStyle = "#111";
  x.font = "bold 58px 'Helvetica Neue', Arial, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(String(num), 64, 44);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  for (const sx of [-1, 1]) {
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), mat);
    cloth.position.set(sx * (halfWidth + 0.02), -0.24, 0.02);
    cloth.rotation.y = (sx * Math.PI) / 2;
    g.add(cloth);
  }
  return g;
}
