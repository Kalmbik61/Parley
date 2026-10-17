"""«Рой» с глазами: облако душ -> сфера (думает) -> лицо из душ (два глаза и рот-силуэт) -> обратно в облако.

blender -b --python swarm3.py -- pose OUTDIR имя [имя ...]   лицо с эмоцией (neutral joy laugh sad surprise anger hmm error warm)
blender -b --python swarm3.py -- sheet OUTDIR                лист эмоций (подписи Golos Text)
blender -b --python swarm3.py -- video OUT.mp4               весь ролик (кадры -> ffmpeg, со звуком из audio2/)

Реплики и огибающая звука — audio2/lipsync.json (make_audio2.py). Без сетки, губ и зубов: души — 2D-пятна со свечением,
положения считает numpy. Глаза — такие же силуэты, как рот; эмоцию задают форма века, наклон, изгиб и размер.
"""
import sys, os, json, math, subprocess, tempfile
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
AUDIO = os.path.join(HERE, "audio2")
FFMPEG = "/opt/homebrew/bin/ffmpeg"


def lin_hex(h):
    h = h.lstrip("#")
    c = np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)


C1, C2, C3 = lin_hex("#EFB05C"), lin_hex("#F48A64"), lin_hex("#F0DDA5")
CERR = lin_hex("#E04A34")            # тёплый красный в духе coral1/coral2 из дизайн-токенов: цвет злости и ошибки
BGC = lin_hex("#100E0C")
TXT = lin_hex("#F3EEE6")


def sm(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3 - 2 * x)


def ramp(t, a, b):
    return sm((t - a) / (b - a))


def ss(e0, e1, x):
    return sm((x - e0) / (e1 - e0))


def smooth_interp(tt, times, vals):
    out = np.zeros_like(tt)
    for k in range(len(times) - 1):
        m = (tt >= times[k]) & (tt < times[k + 1])
        u = (tt[m] - times[k]) / (times[k + 1] - times[k])
        out[m] = vals[k] + (vals[k + 1] - vals[k]) * sm(u)
    out[tt < times[0]] = vals[0]
    out[tt >= times[-1]] = vals[-1]
    return out


def wob(tt, t0, A, f=2.6, d=5.0):
    u = np.maximum(tt - t0, 0)
    return np.where(tt >= t0, A * np.exp(-d * u) * np.sin(2 * np.pi * f * u), 0.0)


def bump(tt, t0, dur, h):
    u = np.clip((tt - t0) / dur, 0, 1)
    return np.where((tt >= t0) & (tt <= t0 + dur), h * 4 * u * (1 - u), 0.0)


def smooth3(a):
    p = np.pad(a, 1, mode="edge")
    return 0.25 * p[:-2] + 0.5 * p[1:-1] + 0.25 * p[2:]


# ================================================================== таймлайн
D = json.load(open(AUDIO + "/lipsync.json"))
FPS, NF = D["fps"], D["n"]
TT = np.arange(NF) / FPS
ENV0, CEN = np.array(D["env"]), np.array(D["cen"])
LINES = D["lines"]
L = {l["id"]: l for l in LINES}
END = LINES[-1]["end"]

T_G = (1.9, 3.7)                       # облако -> сфера («думает»)
T_M = (5.0, 5.8)                       # сфера -> лицо
T_U = (END + 0.85, END + 1.65)         # лицо -> сфера
T_D = (END + 1.65, END + 3.15)         # сфера -> облако
ENV = smooth3(ENV0)

TARGETS = [
    (4.8, dict(Speak=1)),
    (6.0, dict(Speak=0.6, Smile=0.4)),
    (8.6, dict(Smile=0.5, Speak=0.5)),
    (9.9, dict(Smile=0.6, Speak=0.4)),
    (L["l2"]["start"] - 0.15, dict(Smile=1.0)),
    (L["l2"]["start"] + 0.5, dict(Laugh=0.55, Smile=0.45)),
    (L["l2"]["start"] + 1.05, dict(Laugh=0.85, Smile=0.15)),
    (L["l2"]["end"] - 0.1, dict(Laugh=0.7, Smile=0.3)),
    (L["l2"]["end"] + 0.6, dict(Smile=0.6, Speak=0.4)),
    (L["l3"]["start"] - 0.12, dict(Sad=1.0)),
    (L["l3"]["end"], dict(Sad=1.0)),
    (L["l3"]["end"] + 0.55, dict(Speak=0.7, Sad=0.3)),
    (L["l4"]["start"] - 0.10, dict(Surprise=1.0)),
    (L["l4"]["end"], dict(Surprise=1.0)),
    (L["l4"]["end"] + 0.40, dict(Speak=1.0)),
    (L["l5"]["start"] - 0.15, dict(Anger=1.0)),
    (L["l5"]["end"], dict(Anger=1.0)),
    (L["l5"]["end"] + 0.6, dict(Speak=0.6, Hmm=0.4)),
    (L["l6"]["start"] - 0.05, dict(Hmm=1.0)),
    (L["l6"]["end"] - 0.2, dict(Hmm=0.8, Speak=0.2)),
    (L["l7"]["start"] - 0.20, dict(Error=1.0)),
    (L["l7"]["end"] + 0.25, dict(Error=1.0)),
    (L["l7"]["end"] + 0.75, dict(Speak=0.6, Smile=0.4)),
    (L["l8"]["start"] - 0.3, dict(Smile=0.7, Speak=0.3)),
    (L["l8"]["start"] + 0.3, dict(Smile=1.0)),
    (L["l8"]["end"], dict(Smile=0.9, Speak=0.1)),
    (END + 0.35, dict(Smile=1.0)),
    (END + 0.85, dict(Smile=1.0)),
]
TARGETS.sort(key=lambda x: x[0])
EMO = ["Speak", "Smile", "Sad", "Laugh", "Surprise", "Hmm", "Anger", "Error", "Sleepy", "Wink", "Scared", "Love"]
E = {p: smooth_interp(TT, [a for a, _ in TARGETS], [d.get(p, 0.0) for _, d in TARGETS]) for p in EMO}
gate = np.zeros(NF)
for l in LINES:
    gate = np.maximum(gate, ramp(TT, l["start"] - 0.12, l["start"] - 0.02) * (1 - ramp(TT, l["end"] + 0.05, l["end"] + 0.2)))
gate = smooth3(gate)

A_ph = ramp(TT, *T_G) - ramp(TT, *T_D)            # 0 облако, 1 сфера/лицо
M_ph = ramp(TT, *T_M) - ramp(TT, *T_U)            # 0 сфера, 1 лицо

# ---- рот: W, Hu, Hl, S(изгиб уголков), K(перекос), dx, pw(острота уголков), wave(волна — «ошибка»)
POSE = dict(
    Speak=(0.86, 0.15, 0.30, 0.06, 0.00, 0.00, 2.00, 0.0),
    Smile=(0.98, 0.09, 0.24, 0.30, 0.00, 0.00, 1.80, 0.0),
    Laugh=(1.02, 0.16, 0.55, 0.22, 0.00, 0.00, 1.90, 0.0),
    Sad=(0.82, 0.10, 0.05, -0.34, 0.00, 0.00, 1.80, 0.0),
    Surprise=(0.36, 0.34, 0.38, 0.00, 0.00, 0.00, 2.30, 0.0),
    Hmm=(0.70, 0.05, 0.10, 0.08, 0.22, 0.10, 1.80, 0.0),
    Anger=(0.74, 0.05, 0.10, -0.10, 0.00, 0.00, 2.70, 0.0),
    Error=(0.78, 0.03, 0.05, 0.00, 0.00, 0.00, 2.20, 0.05),
    Sleepy=(0.50, 0.03, 0.06, -0.06, 0.00, 0.00, 2.20, 0.0),
    Wink=(0.92, 0.09, 0.20, 0.26, 0.10, 0.05, 1.80, 0.0),
    Scared=(0.48, 0.05, 0.09, -0.06, 0.00, 0.00, 2.20, 0.03),
    Love=(0.90, 0.09, 0.22, 0.28, 0.00, 0.00, 1.80, 0.0),
)
HOLD = dict(Speak=0.15, Smile=0.20, Laugh=0.55, Sad=0.10, Surprise=1.0, Hmm=0.15, Anger=0.10, Error=0.0, Sleepy=0.0, Wink=0.2, Scared=0.2, Love=0.2)
VS = dict(Speak=1.0, Smile=1.0, Laugh=0.9, Sad=1.0, Surprise=0.4, Hmm=0.8, Anger=1.3, Error=0.8, Sleepy=0.6, Wink=1.0, Scared=0.8, Love=1.0)
SG = dict(Speak=0.0, Smile=0.02, Laugh=0.0, Sad=0.14, Surprise=0.0, Hmm=0.06, Anger=0.18, Error=0.05, Sleepy=0.06, Wink=0.02, Scared=0.06, Love=0.02)
HC_U, HC_L = 0.045, 0.07

# ---- глаза: W, H, pe(форма), lid(веко сверху, доля H), th(наклон века, °: + внутренние углы ниже = злость),
#      at/ab(изгиб верхней/нижней кромки: «улыбающийся» глаз), ey, gx, gy(взгляд), xmix(1 = «X» — ошибка), asym («хм»)
EYE_KEYS = ["W", "H", "pe", "lid", "th", "at", "ab", "ey", "gx", "gy", "xmix", "asym", "wink", "heart"]
EYE_DEF = dict(W=0.34, H=0.46, pe=2.0, lid=0.0, th=0.0, at=0.0, ab=0.0, ey=0.0, gx=0.0, gy=0.0, xmix=0.0, asym=0.0, wink=0.0, heart=0.0)
EYE = {
    "Speak": {},
    "Smile": dict(W=0.36, H=0.34, at=0.25, ab=0.90),
    "Laugh": dict(W=0.44, H=0.20, at=0.90, ab=2.20, ey=0.02),
    "Sad": dict(W=0.32, H=0.36, lid=0.22, th=-30, ey=-0.05, gy=-0.08),
    "Surprise": dict(W=0.40, H=0.58, ey=0.08),
    "Hmm": dict(W=0.32, H=0.40, lid=0.06, gx=-0.06, gy=0.06, asym=1),
    "Anger": dict(W=0.42, H=0.36, pe=1.7, lid=0.30, th=28, ey=-0.02, gy=-0.02),
    "Error": dict(W=0.38, H=0.38, xmix=1),
    "Sleepy": dict(W=0.36, H=0.34, lid=0.58, ey=-0.04, gy=-0.04),
    "Wink": dict(W=0.36, H=0.44, wink=1),
    "Scared": dict(W=0.34, H=0.54, lid=0.10, th=-16, gy=0.03),
    "Love": dict(W=0.50, H=0.46, heart=1),
}
EX, EY = 0.74, 0.60                   # положение глаз
MOUTH_CY = -0.34                      # рот ниже глаз
MOUTH_SCALE = 1.0
FACE_SCALE = 1.12


def mouth_from(Ed, env, cen, gate_):
    n = len(env)
    par = np.zeros((8, n))
    for p in EMO:
        for k in range(8):
            par[k] += Ed[p] * POSE[p][k]
    hold = sum(Ed[p] * HOLD[p] for p in EMO)
    vs = sum(Ed[p] * VS[p] for p in EMO)
    sg = sum(Ed[p] * SG[p] for p in EMO)
    rnd = smooth3(env * ss(1400, 850, cen)) * vs
    wid = smooth3(env * ss(1500, 2600, cen)) * vs
    op_sp = np.clip(0.12 + 1.40 * env * vs, 0, 1.4)
    open_fac = hold + (1 - hold) * (gate_ * op_sp + (1 - gate_) * 0.30)
    W, Hu, Hl, S, K, dx, pw, wave = par
    Hu_t = HC_U + (Hu - HC_U) * open_fac + 0.4 * sg * env * gate_ * vs
    Hl_t = HC_L + (Hl - HC_L) * open_fac + sg * env * gate_ * vs
    W_t = W * (1 - 0.33 * rnd + 0.08 * wid)
    hs = 1 + 0.20 * rnd - 0.30 * wid
    return np.stack([W_t, Hu_t * hs, Hl_t * hs, S, K, dx, pw + 0.5 * rnd, wave])


def eyes_from(Ed):
    return {name: sum(Ed[p] * {**EYE_DEF, **EYE[p]}[name] for p in EMO) for name in EYE_KEYS}


def blink_curve(t_arr):
    rng = np.random.default_rng(5)
    ev, t0 = [], 6.3
    while t0 < END + 1.0:
        ev.append(t0)
        if rng.random() < 0.25:
            ev.append(t0 + 0.34)
        t0 += rng.uniform(2.4, 4.4)
    b = np.zeros_like(t_arr)
    for e in ev:
        b = np.maximum(b, np.clip(1 - np.abs(t_arr - e) / 0.11, 0, 1))
    return sm(b)


PARM = mouth_from(E, ENV, CEN, gate)
PARE = eyes_from(E)
BLINK = blink_curve(TT) * (1 - E["Surprise"]) * (1 - E["Laugh"]) * (1 - E["Error"]) * M_ph
TINT = np.clip(0.85 * E["Anger"] + 1.0 * E["Error"] + 0.5 * E["Love"], 0, 1)
JIT = 0.010 * E["Anger"] + 0.016 * E["Error"] + 0.012 * E["Scared"]

# ---- движение тела (сжатие/растяжение, прыжки, наклон)
breath = 0.0225 * (1 + np.sin(2 * np.pi * TT / 7.0 - np.pi / 2))
SZ = 1 + (wob(TT, 3.7, -0.05, 3.0, 7.0) + wob(TT, 5.55, 0.075) + wob(TT, L["l2"]["start"] + 0.55, 0.06)
          + wob(TT, L["l2"]["start"] + 1.15, -0.05, 3.2, 6.0) + wob(TT, L["l3"]["start"] - 0.1, -0.045, 2.2, 5.0)
          + wob(TT, L["l4"]["start"] - 0.1, 0.10, 3.0, 5.5) + wob(TT, L["l5"]["start"] - 0.2, -0.06, 4.0, 6.0)
          + wob(TT, L["l7"]["start"] - 0.25, 0.05, 6.0, 8.0) + wob(TT, L["l8"]["start"] + 0.3, 0.03)
          + wob(TT, T_U[0] + 0.05, -0.035, 3.0, 6.0))
SXY = 1 / np.sqrt(SZ)
UNI = 1 + breath * A_ph + 0.03 * ENV * M_ph
ZPOS = (0.025 * np.sin(2 * np.pi * TT / 5.3) * A_ph + bump(TT, L["l2"]["start"] + 0.5, 0.55, 0.22) + bump(TT, L["l4"]["start"] - 0.1, 0.5, 0.26)
        - 0.12 * ramp(TT, L["l3"]["start"] - 0.2, L["l3"]["start"] + 0.35) * (1 - ramp(TT, L["l3"]["end"] + 0.3, L["l3"]["end"] + 0.9))
        + 0.012 * np.sin(2 * np.pi * 7 * TT) * E["Laugh"] * M_ph)
ROLL = (np.radians(7) * E["Hmm"] - np.radians(5) * E["Sad"] + np.radians(3.5) * np.sin(2 * np.pi * 2.3 * TT) * E["Laugh"]) * M_ph
SHAKE = 0.006 * np.sin(2 * np.pi * 13 * TT) * E["Anger"] * M_ph
think = ramp(TT, 1.9, 2.7) * (1 - ramp(TT, END + 1.0, END + 1.8)) * (1 - 0.6 * M_ph)
flash = np.where(TT >= L["l4"]["start"] - 0.1, np.exp(-6 * np.maximum(TT - (L["l4"]["start"] - 0.1), 0)) * (1 - np.exp(-40 * np.maximum(TT - (L["l4"]["start"] - 0.1), 0))), 0.0)
flash = flash * (1 - ramp(TT, L["l4"]["end"] + 0.5, L["l4"]["end"] + 1.0))
GLOW = (1.0 + 0.30 * ENV * M_ph + 0.20 * E["Laugh"] * M_ph + 0.10 * E["Smile"] * M_ph - 0.22 * E["Sad"] * M_ph + 0.18 * E["Anger"] * M_ph
        + 0.25 * think + 0.40 * flash)


def at(arr, t):
    return float(np.interp(t, TT, arr))


def frame_params(t):
    return dict(m=np.array([at(PARM[k], t) for k in range(8)]), e={k: at(PARE[k], t) for k in EYE_KEYS},
                blink=at(BLINK, t), tint=at(TINT, t), jit=at(JIT, t), err=at(E["Error"], t), sad=at(E["Sad"], t), gl=at(GLOW, t), body=True)


def pose_params(Ed, env=0.55, cen=1200.0, gate_=1.0):
    Ea = {p: np.array([float(Ed.get(p, 0.0))]) for p in EMO}
    m = mouth_from(Ea, np.array([env]), np.array([cen]), np.array([gate_]))[:, 0]
    e = {k: float(v[0]) for k, v in eyes_from(Ea).items()}
    g = Ed.get
    return dict(m=m, e=e, blink=0.0, tint=min(1.0, 0.85 * g("Anger", 0) + g("Error", 0) + 0.5 * g("Love", 0)),
                jit=0.010 * g("Anger", 0) + 0.016 * g("Error", 0) + 0.012 * g("Scared", 0),
                err=g("Error", 0), sad=g("Sad", 0), body=False, force=True,
                gl=1.0 + 0.30 * env + 0.20 * g("Laugh", 0) + 0.10 * g("Smile", 0) - 0.22 * g("Sad", 0) + 0.18 * g("Anger", 0) - 0.25 * g("Sleepy", 0))


# ================================================================== рой
def rot_y(P, a):
    c, s = math.cos(a), math.sin(a)
    return np.stack([c * P[:, 0] + s * P[:, 2], P[:, 1], -s * P[:, 0] + c * P[:, 2]], 1)


def rot_x(P, a):
    c, s = math.cos(a), math.sin(a)
    return np.stack([P[:, 0], c * P[:, 1] - s * P[:, 2], s * P[:, 1] + c * P[:, 2]], 1)


def pramp(t, t0, t1, d):
    dl = 0.5 * (t1 - t0)
    return sm((t - t0 - d * dl) / (t1 - t0 - dl))


def lerp_arc(X, Y, p, axis, amp):
    d = Y - X
    n = np.cross(d, axis)
    nn = np.linalg.norm(n, axis=1, keepdims=True) + 1e-6
    n = n / nn * np.linalg.norm(d, axis=1, keepdims=True)
    return X + d * p[:, None] + n * (amp * np.sin(np.pi * p))[:, None]


def semicircle_icdf(q):
    ug = np.linspace(-1, 1, 4001)
    F = 0.5 + (ug * np.sqrt(np.clip(1 - ug * ug, 0, 1)) + np.arcsin(ug)) / np.pi
    return np.interp(q, F, ug)


def uv_from_xy(xs, ys, nb=32):
    n = len(xs)
    q = (np.argsort(np.argsort(xs)) + 0.5) / n
    u = semicircle_icdf(q)
    bins = np.minimum((q * nb).astype(int), nb - 1)
    w = np.zeros(n)
    for b in range(nb):
        idx = np.where(bins == b)[0]
        if len(idx):
            w[idx] = (np.argsort(np.argsort(ys[idx])) + 0.5) / len(idx)
    return u, w


class Swarm:
    def __init__(self, N=10000, seed=11):
        rng = np.random.default_rng(seed)
        self.N = N
        K = 8
        self.lobe_c = np.array([[-1.15, 0.30, 0.1], [-0.35, 0.62, -0.2], [0.55, 0.50, 0.3], [1.20, 0.05, -0.1],
                                [0.70, -0.55, 0.2], [-0.10, -0.62, -0.3], [-0.95, -0.40, 0.3], [0.10, 0.0, 0.0]]) * 0.80
        lobe_s = np.array([0.30, 0.26, 0.28, 0.32, 0.27, 0.30, 0.25, 0.85])
        w = np.array([0.13, 0.12, 0.13, 0.14, 0.12, 0.13, 0.10, 0.13]); w /= w.sum()
        self.member = rng.choice(K, N, p=w)
        self.gs = lobe_s[self.member] * np.where(rng.random(N) < 0.04, 3.0, 1.0)
        self.g = rng.normal(size=(N, 3)) * np.array([1.0, 0.8, 0.85])
        self.lobe_amp = rng.uniform(0.22, 0.50, (K, 3))
        self.lobe_w = rng.uniform(0.05, 0.13, (K, 3))
        self.lobe_ph = rng.uniform(0, 2 * np.pi, (K, 3))
        self.ph_b = rng.uniform(0, 2 * np.pi, N)
        self.orb_r = rng.uniform(0.015, 0.09, N)
        self.orb_w = rng.uniform(0.35, 1.3, N)
        self.orb_ph = rng.uniform(0, 2 * np.pi, (N, 3))
        # сфера: оболочка + внутреннее ядро
        i = np.arange(N) + 0.5
        phi = np.arccos(1 - 2 * i / N)
        th = np.pi * (1 + 5 ** 0.5) * i
        dirs = np.stack([np.sin(phi) * np.cos(th), np.cos(phi), np.sin(phi) * np.sin(th)], 1)
        dirs = dirs[rng.permutation(N)]
        dirs = dirs + rng.normal(0, 0.03, dirs.shape)
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        self.inner = rng.random(N) < 0.22
        rad = np.where(self.inner, 0.93 * rng.random(N) ** (1 / 3), 1 + rng.normal(0, 0.016, N))
        self.sph = dirs * rad[:, None]
        self.map_face(rng)
        self.map_heart()
        self.mz = rng.normal(0, 0.05, N)
        self.corona = rng.random(N) < 0.17
        self.cr = rng.uniform(0.05, 0.32, N) * np.where(self.grp > 0, 0.55, 1.0)
        self.cw = rng.uniform(0.25, 0.8, N) * rng.choice([-1, 1], N)
        self.cph = rng.uniform(0, 2 * np.pi, N)
        self.d1, self.d2, self.d3, self.d4 = (rng.random(N) for _ in range(4))
        self.d2 = np.where(self.grp > 0, self.d2 * 0.45, self.d2)          # глаза «открываются» раньше рта
        self.ax1, self.ax2 = (rng.normal(size=(N, 3)) for _ in range(2))
        self.arc1 = rng.uniform(-0.9, 0.9, N)
        self.arc2 = rng.uniform(-0.8, 0.8, N)
        self.base_i = np.exp(rng.normal(0, 0.28, N))
        self.sig0 = np.exp(rng.normal(0, 0.22, N))
        self.tw_w = rng.uniform(0.6, 2.4, N); self.tw_ph = rng.uniform(0, 2 * np.pi, N)
        self.fl_w = rng.uniform(0.15, 0.6, N); self.fl_ph = rng.uniform(0, 2 * np.pi, N)
        th_ = rng.random(N) ** 2.4
        col = C1[None, :] + (C3 - C1)[None, :] * th_[:, None]
        acc = rng.random(N) < 0.10
        col[acc] = C2[None, :] * 1.05
        col[self.grp > 0] = col[self.grp > 0] * 0.65 + C3[None, :] * 0.35            # глаза чуть светлее
        self.col = col.astype(np.float32)
        self.qj = rng.normal(size=(N, 3))
        self.qw = rng.uniform(1.5, 4.5, N)
        self.qph = rng.uniform(0, 2 * np.pi, (N, 3))
        self.xs_s = rng.integers(0, 2, N); self.xs_t = rng.uniform(-1, 1, N); self.xs_o = rng.normal(0, 1, N)
        outer = ((self.grp == 1) & (self.u < -0.2)) | ((self.grp == 2) & (self.u > 0.2))
        self.tear = outer & (self.w < 0.18) & (rng.random(N) < 0.85)
        self.tph = rng.integers(0, 2, N) / 2.0 + rng.normal(0, 0.015, N)

    def map_face(self, rng, f_eye=0.15, edge_frac=0.05, psi_ref=0.35 * T_M[0] + 0.4):
        N = self.N
        P = rot_x(rot_y(self.sph, psi_ref), 0.28)
        xs, ys = P[:, 0], P[:, 1]
        order = np.argsort(-ys)                    # верхняя «шапка» проекции сферы -> глаза, остальное -> рот
        ne = int(round(f_eye * N))
        top = order[:2 * ne]
        ox = np.argsort(xs[top])
        left, right = top[ox[:ne]], top[ox[ne:]]
        rest = order[2 * ne:]
        self.grp = np.zeros(N, int); self.grp[left] = 1; self.grp[right] = 2
        self.i_m, self.i_l, self.i_r = rest, left, right
        u, w = np.zeros(N), np.zeros(N)
        for idx in (rest, left, right):
            u[idx], w[idx] = uv_from_xy(xs[idx], ys[idx])
        edge = rng.random(N) < edge_frac
        self.u, self.w = u, np.where(edge, np.round(w), w)

    def map_heart(self):
        """Сердечко (x²+y²−1)³ = x²y³: равномерные точки внутри, сопоставленные частицам глаза по порядку (u, w)."""
        self.heart = np.zeros((self.N, 2))
        rr = np.random.default_rng(3)
        for idx in (self.i_l, self.i_r):
            n = len(idx)
            pts = np.zeros((0, 2))
            while len(pts) < n:
                c = rr.uniform([-1.25, -1.15], [1.25, 1.35], (4 * n, 2))
                ok = (c[:, 0] ** 2 + c[:, 1] ** 2 - 1) ** 3 - c[:, 0] ** 2 * c[:, 1] ** 3 <= 0
                pts = np.concatenate([pts, c[ok]])
            pts = pts[:n]
            uh, wh = uv_from_xy(pts[:, 0], pts[:, 1])
            key_p = np.lexsort((self.w[idx], np.round(self.u[idx] * 8)))
            key_h = np.lexsort((wh, np.round(uh * 8)))
            self.heart[idx[key_p]] = pts[key_h]

    # ---------------------------------------------------------- положения
    def cloud(self, t):
        Lc = self.lobe_c + self.lobe_amp * np.sin(self.lobe_w * 2 * np.pi * t + self.lobe_ph)
        base = Lc[self.member] + self.g * self.gs[:, None] * (1 + 0.10 * np.sin(0.35 * t + self.ph_b))[:, None]
        orb = self.orb_r[:, None] * np.sin(self.orb_w[:, None] * t * np.array([1.0, 0.83, 1.17]) + self.orb_ph)
        P = (base + orb) * (1 + 0.04 * math.sin(2 * math.pi * t / 7.0))
        return rot_y(P, 0.10 * t)

    def sphere(self, t):
        P = self.sph * (1 + 0.02 * math.sin(2 * math.pi * t / 2.4))
        return rot_x(rot_y(P, 0.35 * t + 0.4), 0.28)

    def face(self, t, fp):
        N = self.N
        P = np.zeros((N, 3))
        W, Hu, Hl, S, Kk, dx, pw, wave = fp["m"]
        i0 = self.i_m
        u, w = self.u[i0], self.w[i0]
        prof = (1 - np.abs(u) ** pw) ** (1 / pw)
        x = W * u + dx * (1 - u * u)
        y = S * u * u + Kk * u + wave * np.sin(7.0 * u + 9.0 * t) - Hl * prof + w * (Hu + Hl) * prof
        x -= x.mean(); y -= y.mean()
        P[i0, 0] = x * MOUTH_SCALE
        P[i0, 1] = y * MOUTH_SCALE + MOUTH_CY
        P[i0, 2] = self.mz[i0] * (1 - 0.6 * np.abs(2 * w - 1))
        e = fp["e"]
        a = e["asym"]
        for side, idx in ((-1, self.i_l), (1, self.i_r)):
            wk = e["wink"] if side > 0 else 0.0                                 # подмигивает правый глаз
            Hh = e["H"] * (1 + (-0.30 if side < 0 else 0.25) * a) * (1 - 0.93 * fp["blink"])
            Hh = Hh * (1 - wk) + 0.20 * wk
            lid = e["lid"] + (0.30 * a if side < 0 else 0.0)
            th = math.radians(e["th"]) - (0.0 if side < 0 else math.radians(10) * a)
            ey = e["ey"] + (0.0 if side < 0 else 0.08 * a)
            u, w = self.u[idx], self.w[idx]
            pe = e["pe"]
            hw, hh = 0.5 * e["W"] * (1 + 0.10 * wk), 0.5 * Hh
            prof = (1 - np.abs(u) ** pe) ** (1 / pe)
            top0 = hh * prof + (e["at"] + 0.90 * wk) * hh * (1 - u * u)
            bot0 = -hh * prof + (e["ab"] + 2.20 * wk) * hh * (1 - u * u)
            x = hw * u
            lid_line = hh - lid * Hh - math.tan(th) * (-side * x)
            top = np.maximum(np.minimum(top0, lid_line), bot0 + 0.03)
            y = bot0 + w * (top - bot0)
            xm = e["xmix"]
            if xm > 1e-3:
                tt_ = self.xs_t[idx]
                sg = np.where(self.xs_s[idx] == 0, 1.0, -1.0)
                off = self.xs_o[idx] * 0.02
                xx = 0.5 * e["W"] * tt_ + off * 0.7
                yy = 0.5 * e["H"] * tt_ * sg + off * 0.7
                x, y = x * (1 - xm) + xx * xm, y * (1 - xm) + yy * xm
            if e["heart"] > 1e-3:
                hs = e["W"] / 2.4 * (1 + 0.07 * math.sin(2 * math.pi * 1.5 * t))
                x = x * (1 - e["heart"]) + self.heart[idx, 0] * hs * e["heart"]
                y = y * (1 - e["heart"]) + (self.heart[idx, 1] - 0.1) * hs * e["heart"]
            P[idx, 0] = x + side * EX + e["gx"]
            P[idx, 1] = y + EY + ey + e["gy"]
            P[idx, 2] = self.mz[idx] * 0.6
        q = 0.010 * np.sin(self.qw[:, None] * t + self.qph) * self.qj
        if fp["jit"] > 0:
            q = q + fp["jit"] * np.sin(self.qw[:, None] * 5.0 * t + self.qph) * self.qj
        ang = self.cw * t + self.cph
        co = np.stack([np.cos(ang), 0.75 * np.sin(ang), 0.5 * np.sin(1.7 * ang)], 1) * self.cr[:, None]
        P = P + q + np.where(self.corona[:, None], co, 0.0)
        P[:, :2] *= FACE_SCALE
        return P

    # ---------------------------------------------------------- состояние на момент t
    def state(self, t, fp):
        N = self.N
        Pc, Ps, Pm = self.cloud(t), self.sphere(t), self.face(t, fp)
        if fp.get("force"):
            pG = pM = np.ones(N)
        else:
            pG = pramp(t, *T_G, self.d1) - pramp(t, *T_D, self.d4)
            pM = pramp(t, *T_M, self.d2) - pramp(t, *T_U, self.d3)
        Pb = lerp_arc(Ps, Pm, pM, self.ax2, 0.45 * self.arc2)
        P = lerp_arc(Pc, Pb, pG, self.ax1, 0.55 * self.arc1)
        fade = np.ones(N)
        # слёзы: несколько капель стекают с нижнего края глаза
        if fp["sad"] > 0.05:
            ph = (t * 0.28 + self.tph) % 1.0
            fall = ph ** 1.5
            m = self.tear
            P[m, 1] -= fall[m] * 0.40 * fp["sad"] * pM[m]
            fade[m] = (1 - fall[m]) ** 0.5
        # глитч при ошибке: полосы смещаются по горизонтали, часть душ гаснет
        if fp["err"] > 0.05:
            r = np.random.default_rng(1000 + int(t * 9))
            yb, hb, sh = r.uniform(-0.8, 0.95), r.uniform(0.06, 0.20), r.uniform(-0.28, 0.28) * fp["err"]
            band = np.abs(P[:, 1] - yb) < hb
            P[band, 0] += sh * pM[band]
            fade[r.random(N) < 0.10 * fp["err"]] *= 0.15
        # яркость
        tw = 0.80 + 0.20 * np.sin(self.tw_w * t + self.tw_ph)
        fl = 1.0 + 1.6 * np.maximum(0, np.sin(self.fl_w * t + self.fl_ph)) ** 40
        m_ = fp["m"]
        e = fp["e"]
        dens_m = np.clip(m_[0] * (m_[1] + m_[2]) / (0.86 * 0.45), 0.25, 1.6) ** 0.6
        dens_e = np.clip(e["W"] * e["H"] * (1 - 0.6 * e["lid"]) / (0.34 * 0.46), 0.25, 1.6) ** 0.6
        dens = np.where(self.grp == 0, dens_m, dens_e)
        lvl = LV_C + (LV_S - LV_C) * pG + (LV_M * dens - LV_S) * pM
        inn = 1 - 0.55 * pG * (1 - pM) * self.inner
        cor = 1 - 0.50 * pM * self.corona
        nrm = Ps / np.maximum(np.linalg.norm(Ps, axis=1, keepdims=True), 1e-6)
        lam = np.clip(nrm @ LIGHT, 0, 1)
        nz = nrm[:, 2]
        shade = (0.28 + 1.05 * lam) * (0.30 + 0.70 * sm((nz + 0.25) / 0.7)) + 0.50 * (1 - np.abs(nz)) ** 3
        shade = np.where(self.inner, 0.55, shade)
        sph_m = 1 + (shade - 1) * pG * (1 - pM)
        z = P[:, 2]
        dc = 0.85 + 0.15 * np.clip((z + 1) / 2, 0, 1) * (1 - pG)
        I = self.base_i * tw * fl * lvl * inn * cor * sph_m * dc * fp["gl"] * fade
        dof = (1.25 * (1 - pG) + 0.40 * pG * (1 - pM) + 0.15 * pM)
        sig = self.sig0 * (1.0 + dof * np.abs(z) * 0.9)
        k = (fp["tint"] * pM)[:, None] if np.ndim(pM) else fp["tint"] * pM
        col = self.col * (1 - k) + CERR[None, :] * (1.15 * k)
        return P, I, sig, col


LIGHT = np.array([-0.45, 0.55, 0.70]); LIGHT = LIGHT / np.linalg.norm(LIGHT)
LV_C, LV_S, LV_M = 0.40, 0.72, 0.55     # уровни яркости: облако / сфера / лицо

# ================================================================== рендер
SIGS = np.array([0.7, 0.95, 1.3, 1.8, 2.5, 3.5, 5.0, 7.5, 11.0])
_cache = {}


def splat(H, Wd, x, y, sig, rgb, SC):
    acc = [np.zeros(H * Wd, np.float64) for _ in range(3)]
    cls = SIGS * SC
    k = np.abs(np.log(np.maximum(sig, 1e-3))[:, None] - np.log(cls)[None, :]).argmin(1)
    for c, s0 in enumerate(cls):
        m = np.where(k == c)[0]
        if len(m) == 0:
            continue
        r = int(math.ceil(3.0 * s0)) + 1
        o = np.arange(-r, r + 1)
        OX, OY = np.meshgrid(o, o)
        OX, OY = OX.ravel(), OY.ravel()
        xi, yi = np.floor(x[m]).astype(np.int64), np.floor(y[m]).astype(np.int64)
        px, py = xi[:, None] + OX[None, :], yi[:, None] + OY[None, :]
        dx, dy = px + 0.5 - x[m][:, None], py + 0.5 - y[m][:, None]
        d2 = dx * dx + dy * dy
        w = 0.40 * np.exp(-d2 / (2 * s0 * s0)) + 0.85 * np.exp(-d2 / (2 * (0.42 * s0) ** 2))
        ok = (px >= 0) & (px < Wd) & (py >= 0) & (py < H)
        idx = (py * Wd + px)[ok]
        for ch in range(3):
            acc[ch] += np.bincount(idx, weights=(w * rgb[m, ch][:, None])[ok], minlength=H * Wd)
    return np.stack(acc, -1).reshape(H, Wd, 3).astype(np.float32)


def bloom(hdr, SC):
    H, Wd, _ = hdr.shape
    h2 = hdr.reshape(H // 2, 2, Wd // 2, 2, 3).mean((1, 3))
    key = (H, Wd, SC)
    if key not in _cache:
        fy = np.fft.fftfreq(H // 2)[:, None]
        fx = np.fft.rfftfreq(Wd // 2)[None, :]
        f2 = fx * fx + fy * fy
        _cache[key] = [(np.exp(-2 * np.pi ** 2 * (s * SC) ** 2 * f2).astype(np.float32), wt) for s, wt in ((3, 0.30), (9, 0.20), (26, 0.12))]
    F = np.fft.rfft2(h2, axes=(0, 1))
    out = np.zeros_like(h2)
    for G, wt in _cache[key]:
        out += wt * np.fft.irfft2(F * G[..., None], s=(H // 2, Wd // 2), axes=(0, 1))
    return np.repeat(np.repeat(out, 2, 0), 2, 1).astype(np.float32)


def bg_map(H, Wd):
    key = ("bg", H, Wd)
    if key not in _cache:
        yy, xx = np.mgrid[0:H, 0:Wd].astype(np.float32)
        r2 = ((xx - Wd / 2) / (Wd / 2)) ** 2 + ((yy - H * 0.47) / (H / 2)) ** 2
        g = np.exp(-r2 * 1.6)
        _cache[key] = (BGC[None, None, :] * (0.55 + 0.75 * g[..., None])).astype(np.float32)
    return _cache[key]


def oetf(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * x ** (1 / 2.4) - 0.055)


def frame_hdr(sw, t, Wd, H, SC, fp):
    P, I, sig, col = sw.state(t, fp)
    if fp.get("body", True):
        a = at(A_ph, t)
        sz = 1 + (at(SZ, t) - 1) * a
        sxy = 1 + (at(SXY, t) - 1) * a
        uni, zp, roll, shake = at(UNI, t), at(ZPOS, t) * a, at(ROLL, t), at(SHAKE, t)
    else:
        sz = sxy = uni = 1.0
        zp = roll = shake = 0.0
    X = P[:, 0] * sxy * uni + shake
    Y = P[:, 1] * sz * uni
    c, s = math.cos(roll), math.sin(roll)
    X, Y = c * X - s * Y, s * X + c * Y
    Y = Y + zp - 0.12                    # лицо чуть выше центра кадра занимает место под субтитры
    K = 290.0 * SC
    persp = 1.0 / (1.0 - 0.06 * P[:, 2])
    px = Wd / 2 + K * X * persp
    py = H * 0.47 - K * Y * persp
    en = (1.7 * SC) / (sig * SC)
    rgb = col * (I * np.clip(en, 0.05, 1.0) ** 1.2)[:, None]
    return splat(H, Wd, px, py, sig * SC * 1.7, rgb, SC)


def text_layer_lin(subs, t, H, Wd):
    txt = np.zeros((H, Wd, 3), np.float32)
    if subs:
        for (l, mask) in subs:
            va = float(ramp(t, l["start"] - 0.2, l["start"]) * (1 - ramp(t, l["end"] + 0.1, l["end"] + 0.5)))
            if va > 1e-3:
                txt += mask[..., None] * (TXT * 0.80 * va)[None, None, :]
    return txt


def finish(hdr, SC, expo=1.35, seed=0, txt=None):
    H, Wd, _ = hdr.shape
    lin = hdr + bloom(hdr, SC) + bg_map(H, Wd)
    if txt is not None:
        lin = lin + txt
    srgb = oetf(1 - np.exp(-expo * lin))
    rng = np.random.default_rng(seed)
    return np.clip(srgb * 255 + rng.uniform(-0.5, 0.5, srgb.shape), 0, 255).astype(np.uint8)


def render_frame(sw, t, Wd=1080, H=1080, nsub=1, subs=None, fp_fixed=None, seed=0):
    SC = Wd / 1080.0
    acc = None
    for k in range(nsub):
        ts = t + ((k + 0.5) / nsub - 0.5) * (0.5 / FPS) if nsub > 1 else t
        h = frame_hdr(sw, ts, Wd, H, SC, fp_fixed or frame_params(ts))
        acc = h if acc is None else acc + h
    return finish(acc / nsub, SC, seed=seed, txt=text_layer_lin(subs, t, H, Wd) if subs else None)


def save_png(img, path):
    H, Wd, _ = img.shape
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{Wd}x{H}", "-i", "-", "-frames:v", "1", path],
                   input=img.tobytes(), check=True)


def load_subs(Wd, H):
    import sheet_utils as U
    tmp = tempfile.mkdtemp(prefix="swarm3_subs_")
    out = []
    for l in LINES:
        text = l["text"]
        if len(text) > 26:
            cuts = [i + 1 for i in range(len(text) - 2) if text[i:i + 2] in (". ", "! ", "? ")]
            cut = min(cuts, key=lambda c: abs(c - len(text) / 2)) if cuts else text.rfind(" ", 0, len(text) // 2 + 6)
            text = text[:cut].strip() + "\n" + text[cut:].strip()
        lay = U.text_layer(Wd, H, [(text, Wd / 2, H * 0.80, 40 * Wd / 1080, "#FFFFFF", "Medium", "CENTER")], f"{tmp}/sub_{l['id']}.png")
        out.append((l, np.ascontiguousarray(lay[::-1, :, 3])))
    return out


EPOSES = dict(neutral=dict(Speak=1), joy=dict(Smile=1), laugh=dict(Laugh=1), sad=dict(Sad=1), surprise=dict(Surprise=1),
              anger=dict(Anger=1), hmm=dict(Hmm=1), error=dict(Error=1), warm=dict(Smile=0.8, Speak=0.2),
              sleepy=dict(Sleepy=1), wink=dict(Wink=1), scared=dict(Scared=1), love=dict(Love=1))


def main():
    a = sys.argv[sys.argv.index("--") + 1:]
    mode = a[0]
    sw = Swarm()
    if mode == "pose":
        out, names = a[1], a[2:]
        RES = int(os.environ.get("SW_RES", 720))
        for nm in names:
            fp = pose_params(EPOSES[nm], env=float(os.environ.get("SW_ENV", 0.5)))
            save_png(render_frame(sw, float(os.environ.get("SW_T", 7.0)), RES, RES, fp_fixed=fp), f"{out}/p_{nm}.png")
            print("POSE", nm, flush=True)
    elif mode == "sheet":
        out = a[1]
        import sheet_utils as U
        tiles = [("neutral", 0.35, "Спокойно", "круглые глаза, рот-силуэт"), ("joy", 0.5, "Радость", "глаза-улыбки"), ("laugh", 0.6, "Смех", "глаза-дуги, широкий рот"),
                 ("sad", 0.5, "Грусть", "веки опущены, слеза"), ("surprise", 0.5, "Удивление", "большие глаза, «О»"), ("anger", 0.6, "Злость", "скошенные веки, красный оттенок"),
                 ("hmm", 0.4, "«Хм…»", "один глаз выше, взгляд вверх"), ("error", 0.5, "Ошибка", "глаза-крестики, глитч"),
                 ("sleepy", 0.2, "Сонно", "веки наполовину, тише свет"), ("wink", 0.4, "Подмигивание", "правый глаз — дуга"),
                 ("scared", 0.4, "Испуг", "широкие глаза, дрожь"), ("love", 0.4, "Нежность", "глаза-сердечки")]
        paths, caps = [], []
        for nm, env, title, sub in tiles:
            p = f"{out}/sh_{nm}.png"
            save_png(render_frame(sw, 7.0, 760, 760, fp_fixed=pose_params(EPOSES[nm], env=env)), p)
            paths.append(p); caps.append((title, sub))
        W, H = U.compose_sheet(paths, caps, 4, 760, "Джарвис — рой с глазами", "два глаза и рот — такие же силуэты из душ; эмоцию задают форма век, наклон и цвет", f"{out}/swarm3_sheet.png")
        print("SHEET", W, H)
    elif mode == "video":
        outp = a[1]
        RES = int(os.environ.get("SW_RES", 1080))
        NSUB = int(os.environ.get("SW_NSUB", 4))
        subs = load_subs(RES, RES)
        cmd = [FFMPEG, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{RES}x{RES}", "-r", str(FPS), "-i", "-",
               "-i", AUDIO + "/voice.wav",
               "-vf", "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p",
               "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
               "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", outp]
        pr = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        for f in range(NF):
            tf = f / FPS
            fast = any(x - 0.15 <= tf <= y + 0.15 for x, y in (T_G, T_M, T_U, T_D))
            ns = NSUB if fast else (max(1, NSUB // 2) if at(gate, tf) > 0.5 else 1)
            pr.stdin.write(render_frame(sw, tf, RES, RES, nsub=ns, subs=subs, seed=f).tobytes())
            if f % 40 == 0:
                print("FRAME", f, flush=True)
        pr.stdin.close(); pr.wait()
        print("VIDEO_DONE", outp)
    print("SWARM3_OK", mode)


if __name__ == "__main__":
    main()
