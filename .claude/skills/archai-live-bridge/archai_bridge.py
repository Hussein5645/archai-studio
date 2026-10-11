"""
ArchAI Live Bridge client for agents and scripts (see SKILL.md next to this file).

    python archai_bridge.py status   --key K [--name N] [--app A]
    python archai_bridge.py projects
    python archai_bridge.py push     --key K --spec objects.json [--name N] [--app A] [--partial] [--delete id,id]
    python archai_bridge.py pull     --key K --out model.glb [--fresh]

Talks to the ArchAI desktop app on 127.0.0.1:47821 (ARCHAI_LIVE_PORT overrides) with protocol 2,
using the plugins' own core (plugins/python/archai_core.py, standard library only). Every reply is
printed as JSON on stdout.

A push spec is JSON: {"objects": [object, ...]} where each object is
    {"id": "...", "name": "...", "category": "...", "color": "#rrggbb",
     "box": [x, y, z, width, depth, height]}                       a box, or
    {"id": ..., "positions": [x, y, z, ...], "indices": [i, ...]}   a triangle mesh
in ArchAI millimetres: x right, plan y DOWN, z = elevation up. Ids are yours and must stay the
same between pushes (they are how ArchAI recognises an object again).
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
CORE = os.environ.get("ARCHAI_CORE") or os.path.normpath(os.path.join(HERE, "..", "..", "..", "plugins", "python"))
sys.path.insert(0, CORE)
import archai_core as core  # noqa: E402


def base():
    port = os.environ.get("ARCHAI_LIVE_PORT", "")
    return "http://127.0.0.1:%d" % (int(port) if port.isdigit() else core.LIVE_PORT)


def request(method, path, body=None, timeout=180):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base() + path, data=data, method=method,
                                 headers={"X-ArchAI-Live": "1", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.status, dict(response.headers), response.read()


def status(key, name, app, project=""):
    query = urllib.parse.urlencode({"key": key, "name": name, "app": app, "protocol": 2, "project": project})
    _, _, body = request("GET", "/live/status?" + query, timeout=10)
    return json.loads(body.decode("utf-8"))


def box_mesh(x, y, z, w, d, h):
    """Twelve triangles of a box (ArchAI mm), wound as the plugins send them (a Z-up host's
    outward winding, mirrored by plan y pointing down)."""
    xs, ys, zs = (x, x + w), (y, y + d), (z, z + h)
    positions = []
    for k in range(8):
        positions += [xs[k & 1], ys[(k >> 1) & 1], zs[(k >> 2) & 1]]
    quads = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    indices = []
    for a, b, c, e in quads:
        indices += [a, c, b, a, e, c]
    return positions, indices


def scene_objects(spec):
    objects = []
    for number, item in enumerate(spec.get("objects") or [], 1):
        o = core.SceneObject(str(item.get("id") or "obj%d" % number), item.get("name") or "", item.get("category") or "")
        colour = (item.get("color") or "#cccccc").lstrip("#")
        rgb = [int(colour[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
        material = core.Material(item.get("material") or "#" + colour, *rgb)
        if "box" in item:
            positions, indices = box_mesh(*[float(v) for v in item["box"]])
        else:
            positions, indices = [float(v) for v in item["positions"]], [int(i) for i in item["indices"]]
        o.add_mesh(material, positions, indices)
        if item.get("archai"):
            o.archai = item["archai"]
        objects.append(o)
    return objects


def main():
    parser = argparse.ArgumentParser(description="ArchAI Live Bridge client")
    parser.add_argument("action", choices=["status", "projects", "push", "pull"])
    parser.add_argument("--key", default="agent", help="stable id of this model (one source in ArchAI)")
    parser.add_argument("--name", default="Agent model")
    parser.add_argument("--app", default="Agent")
    parser.add_argument("--spec", help="push: JSON file of objects")
    parser.add_argument("--partial", action="store_true", help="push: only these objects; nothing missing is deleted")
    parser.add_argument("--delete", default="", help="push: ids of your objects to delete (comma separated)")
    parser.add_argument("--out", help="pull: where to write the binary glTF")
    parser.add_argument("--fresh", action="store_true", help="pull: everything, not only what changed")
    args = parser.parse_args()

    if args.action == "projects":
        _, _, body = request("GET", "/live/projects", timeout=10)
        print(body.decode("utf-8"))
        return

    state = status(args.key, args.name, args.app)
    document = state.get("document")
    if args.action == "status" or not document:
        if not document:
            state["note"] = "ArchAI has no project open yet (on its Home screen it opens one for this key); retry in a few seconds."
        print(json.dumps(state, indent=2))
        return
    if state.get("mismatch"):
        print(json.dumps({"refused": True, "message": "ArchAI shows another project than the one this key is linked to", "status": state}, indent=2))
        sys.exit(2)
    project = document.get("id")
    if not state.get("bound"):
        request("POST", "/live/bind", {"key": args.key, "app": args.app, "name": args.name, "project": project}, timeout=60)

    if args.action == "push":
        with open(args.spec, encoding="utf-8") as f:
            spec = json.load(f)
        exchange = core.write_exchange(args.name, args.app, "agent", "", scene_objects(spec))
        body = {"protocol": 2, "key": args.key, "app": args.app, "name": args.name, "project": project,
                "changeId": uuid.uuid4().hex, "complete": not args.partial,
                "deleted": [i for i in args.delete.split(",") if i], "model": exchange}
        _, _, reply = request("POST", "/live/push", body)
        print(reply.decode("utf-8"))
    else:
        query = urllib.parse.urlencode({"key": args.key, "protocol": 2, "project": project, **({"fresh": 1} if args.fresh else {})})
        code, headers, data = request("GET", "/live/pull?" + query)
        if code == 204 or not data:
            print(json.dumps({"changed": False}))
            return
        with open(args.out or "archai-live.glb", "wb") as f:
            f.write(data)
        summary = {"file": os.path.abspath(args.out or "archai-live.glb"), "bytes": len(data),
                   "revision": headers.get("X-ArchAI-Revision") or headers.get("x-archai-revision")}
        try:
            objects, bridge = core.read_bridge_glb(data)
            summary["bridge"] = bridge
            summary["nodes"] = [(n.get("extras") or {}).get("archai") for n in core._parse_glb(data).nodes if (n.get("extras") or {}).get("archai")]
        except Exception as error:  # noqa: BLE001
            summary["parseError"] = str(error)
        print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
