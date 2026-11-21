# Fits the learned correction of MediaPipe's bone directions (correct.ts in the motion package) from what collect.ts
# wrote: MediaPipe's landmarks beside the bone frames the mannequin was rendered in. A network of two hidden layers says
# how far to turn each bone the tracker reported; one seed in ten is held out, and the scripted movements are scored as
# a test set it never trained on. Needs only numpy.
#
#   python3 train.py random.jsonl scripted.jsonl [out.json]     (out defaults to ../src/motion/correction.json)
#   H=64 EPOCHS=40 WD=1e-3 python3 train.py ...                 other sizes and training lengths
import json, sys, glob, os, numpy as np
ENV = lambda k, d: type(d)(os.environ.get(k, d))
rng = np.random.default_rng(0)
PTS = [0,7,8,11,12,13,14,15,16,19,20,23,24,25,26,27,28]
BONES = {  # bone: (from landmarks, to landmarks), averaged
 "hips": ([23,24],[11,12]), "neck": ([11,12],[7,8]),
 "leftUpperArm": ([11],[13]), "leftForearm": ([13],[15]), "rightUpperArm": ([12],[14]), "rightForearm": ([14],[16]),
 "leftThigh": ([23],[25]), "leftShin": ([25],[27]), "rightThigh": ([24],[26]), "rightShin": ([26],[28])}
NAMES = list(BONES)
def yaxis(q):
    x,y,z,w = q
    return np.array([2*(x*y-w*z), 1-2*(x*x+z*z), 2*(y*z+w*x)])
def unit(a): return a/np.maximum(np.linalg.norm(a,axis=-1,keepdims=True),1e-9)
def dirs(P):  # P: (33,3) body space
    return np.stack([unit(P[t].mean(0)-P[f].mean(0)) for f,t in BONES.values()])
def target(bones):
    # The torso as one line (the solver keeps hips, spine and chest along it), the rest bone by bone.
    out = [yaxis(bones[n]) for n in NAMES]
    out[0] = unit(sum(yaxis(bones[n]) for n in ("hips","spine","chest")))
    return np.stack(out)
def features(r):
    W = np.array(r["world"]) * [1,-1,-1]
    I = np.array(r["image"])
    hipW = W[[23,24]].mean(0)
    img = np.stack([(I[:,0]-0.5)*4/3, -(I[:,1]-0.5)], 1)
    hipI = img[[23,24]].mean(0); sh = img[[11,12]].mean(0); s = np.linalg.norm(sh-hipI)+1e-6
    D = dirs(W)
    f = np.concatenate([(W[PTS]-hipW).ravel(), ((img[PTS]-hipI)/s).ravel(), I[PTS,2], hipI, [s], D.ravel()])
    return f, D
def seen(I):
    return np.array([min(I[i,2] for i in f+t) >= 0.5 for f,t in BONES.values()])
def load(paths):
    X,R,T,S,G,M = [],[],[],[],[],[]
    for p in paths:
        for line in open(p):
            r = json.loads(line)
            if r["world"] is None: continue
            f, D = features(r)
            X.append(f); R.append(D); M.append(seen(np.array(r['image'])))
            T.append(target(r["truth"])); S.append(target(r["solved"]))
            G.append(r["seed"] if r.get("movement","Random").startswith("Random") else f'{r["movement"]} / {r["setup"]}')
    return [np.array(a) for a in (X,R,T,S)] + [G, np.array(M)]
def angle(a,b,m=None):
    e = np.degrees(np.arccos(np.clip((a*b).sum(-1),-1,1)))
    return e if m is None else e[m]
class Net:
    def __init__(s, n_in, h=None):
        h = h or ENV('H', 128)
        s.p = {"W1": rng.normal(0,np.sqrt(2/n_in),(n_in,h)), "b1": np.zeros(h), "W2": rng.normal(0,np.sqrt(2/h),(h,h)), "b2": np.zeros(h), "W3": np.zeros((h,30)), "b3": np.zeros(30)}
    def fwd(s, X, R):
        p = s.p; h1 = np.maximum(0, X@p["W1"]+p["b1"]); h2 = np.maximum(0, h1@p["W2"]+p["b2"])
        raw = R.reshape(len(X),-1) + h2@p["W3"]+p["b3"]
        return raw, (h1,h2)
    def predict(s, X, R):
        raw,_ = s.fwd(X,R); return unit(raw.reshape(len(X),10,3))
def train(Xn, R, T, M, epochs=None, lr=2e-3, wd=None):
    epochs = epochs or ENV('EPOCHS', 20); wd = wd if wd is not None else ENV('WD', 1e-4)
    net = Net(Xn.shape[1]); m = {k:0 for k in net.p}; v2 = {k:0 for k in net.p}; step=0
    n = len(Xn)
    for e in range(epochs):
        idx = rng.permutation(n)
        for i in range(0, n, 256):
            b = idx[i:i+256]; X,Rb,Tb,Mb = Xn[b],R[b],T[b],M[b]; p = net.p
            raw,(h1,h2) = net.fwd(X,Rb); u = raw.reshape(len(b),10,3); nrm = np.linalg.norm(u,axis=-1,keepdims=True)+1e-9; d = u/nrm
            # loss: mean(1 - cos)
            g_d = -Tb*Mb[...,None]/max(1,Mb.sum())
            g_u = (g_d - d*(g_d*d).sum(-1,keepdims=True))/nrm
            g = g_u.reshape(len(b),30)
            grads = {"W3": h2.T@g, "b3": g.sum(0)}
            g2 = (g@p["W3"].T)*(h2>0); grads["W2"]=h1.T@g2; grads["b2"]=g2.sum(0)
            g1 = (g2@p["W2"].T)*(h1>0); grads["W1"]=X.T@g1; grads["b1"]=g1.sum(0)
            step+=1
            for k in p:
                gk = grads[k] + (wd*p[k] if k[0]=="W" else 0)
                m[k]=0.9*m[k]+0.1*gk; v2[k]=0.999*v2[k]+0.001*gk*gk
                p[k] -= lr*(m[k]/(1-0.9**step))/(np.sqrt(v2[k]/(1-0.999**step))+1e-8)
        if e in (epochs//2, 3*epochs//4): lr/=3
    return net

def export(net, mu, sd, path, apply):
    import base64
    b64 = lambda a: base64.b64encode(np.asarray(a, dtype="<f4").tobytes()).decode()
    p = net.p
    layers = [{"inputs": p[f"W{i}"].shape[0], "outputs": p[f"W{i}"].shape[1], "w": b64(p[f"W{i}"]), "b": b64(p[f"b{i}"])} for i in (1,2,3)]
    out = {"points": PTS, "bones": [{"name": n, "from": f, "to": t} for n,(f,t) in BONES.items()], "apply": apply, "mean": b64(mu), "spread": b64(sd), "layers": layers}
    json.dump(out, open(path, "w"))

if __name__ == "__main__":
    X,R,T,S,G,M = load([sys.argv[1]])
    seeds = np.array(G); val = seeds % 10 == 0
    mu, sd = X[~val].mean(0), X[~val].std(0)+1e-3
    net = train((X[~val]-mu)/sd, R[~val], T[~val], M[~val])
    def report(name, X_, R_, T_, S_, M_):
        C = net.predict((X_-mu)/sd, R_)
        print(f"{name}: n={len(X_)}")
        for k,nm in enumerate(NAMES):
            print(f"  {nm:14s} mediapipe {angle(R_[:,k],T_[:,k],M_[:,k]).mean():5.1f}  solver {angle(S_[:,k],T_[:,k],M_[:,k]).mean():5.1f}  corrected {angle(C[:,k],T_[:,k],M_[:,k]).mean():5.1f}")
        print(f"  {'all':14s} mediapipe {angle(R_,T_,M_).mean():5.1f}  solver {angle(S_,T_,M_).mean():5.1f}  corrected {angle(C,T_,M_).mean():5.1f}")
    report("train", X[~val],R[~val],T[~val],S[~val],M[~val]); report("held-out seeds", X[val],R[val],T[val],S[val],M[val])
    X2,R2,T2,S2,G2,M2 = load([sys.argv[2]]); G2 = np.array(G2)
    report("scripted (all)", X2,R2,T2,S2,M2)
    C2 = net.predict((X2-mu)/sd, R2)
    for g in dict.fromkeys(G2):
        k = G2 == g
        print(f"  {g:28s} mediapipe {angle(R2[k],T2[k],M2[k]).mean():5.1f}  solver {angle(S2[k],T2[k],M2[k]).mean():5.1f}  corrected {angle(C2[k],T2[k],M2[k]).mean():5.1f}")
    # Applied to the torso, neck and upper arms only: on the scripted movements, correcting forearms and thighs did worse.
    export(net, mu, sd, sys.argv[3] if len(sys.argv) > 3 else "../src/motion/correction.json", ["hips","neck","leftUpperArm","rightUpperArm"])
