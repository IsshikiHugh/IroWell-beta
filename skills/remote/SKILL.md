---
name: remote
description: Make something served on this machine open in the user's browser, when the system prompt has a "Remote machine" section (the session runs on a server the user reaches over SSH). Forwards a port of this machine to the user's computer and gives the localhost URL to hand them. Use before giving the user the URL of a server, dashboard or preview running here (dev server, TensorBoard, Jupyter, Gradio, a static-file preview), when a program printed a URL with this machine's hostname or IP, or when the user says a link or a port does not open.
user-invocable: false
---

# Reaching this machine from the user's computer

The user reads this conversation in a browser on their own computer. When your system prompt has a "Remote machine" section, this session runs somewhere else: a URL that names this machine (its hostname, its IP, `0.0.0.0`, the SSH name) does not open for them, and neither does `localhost:<port>` until that port is forwarded. Without that section the session runs on the user's own computer: `http://localhost:<port>/` works as it is and there is nothing to forward.

## Forward a port

```sh
node <this skill's base directory>/port.mjs <port>[:<local port>] ...
```

`<port>` is the port on this machine. It asks the IroWell client on the user's computer to forward each one, and prints where the port is there:

```
6006 -> http://localhost:6006/
8902 -> http://localhost:53124/   (port 8902 here is local port 53124 for the user: 8902 is taken on the user's computer)
```

- Without `:<local port>` the user's computer uses the same number when it is free there, else a free one, and the line says why (taken there, or below 1024).
- `8902:1234` asks for local port 1234. Use it only when the user wants a particular local port; when that one is not free the script says so and forwards nothing, and you ask again with another or without one.
- A port that is forwarded already (by an earlier call, by the user in the Ports dialog, or by their `~/.ssh/config`) is answered with the URL it has, also when its local port was chosen by someone else: asking again is safe, and is how you look up a link you gave earlier. To move it to another local port, the user removes it under **Ports** first.
- The forward reaches `localhost:<port>` on this machine, so a server that listens on `127.0.0.1` is enough. Don't bind `0.0.0.0` for this.
- Ask once the server is up, or just before: the forward needs only the number.
- It lasts while the user's client stays connected to this machine. If a link you gave earlier stops opening, run the script again.

What the script can answer instead:

| Output | Meaning | Do |
|---|---|---|
| `(the user is on this machine: nothing to forward)` | The session is not remote after all | Give the `localhost` URL as it is |
| `No IroWell client ... is connected` | The user's browser is away, so nothing can forward now | Give the `http://localhost:<port>/` URL and say it opens once they add the port under **Ports**, next to the server's name in the sidebar |
| `The server doesn't know "portRequest"` | This server runs an older IroWell | Tell the user to reconnect to update, or to add the port under **Ports** |
| another error | e.g. no free port, ssh could not listen | Report it as it is |

## Two port numbers

A forwarded port has two numbers, and they can differ: the port the process listens on **here**, and the **local** port on the user's computer that reaches it. Say the script printed `8902 -> http://localhost:1234/`:

| The user wants | Give |
|---|---|
| A link to open, a URL to paste into their browser or a tool on their computer | The local port: `http://localhost:1234/` |
| The port the process actually runs on, was started with, or is configured to use | The real one: 8902 |
| Something done on this machine (a `curl` you run here, a config file, another service here that calls it, `lsof`, killing it) | The real one: 8902 |

When the two differ and you mention the service, name both once so neither surprises them: "it listens on 8902 on the server; from your computer it is at http://localhost:1234/". Never report the local port as the port the process runs on, and never put the real port in a link when the local one is different.

## The URL you give the user

Keep the scheme, the path, the query and any token; replace only the host and the port:

- `http://gpu-node-3:6006/#scalars` → `http://localhost:6006/#scalars`
- `http://0.0.0.0:8902/lab?token=abc` → `http://localhost:1234/lab?token=abc` (when the script printed local port 1234)

This is for what runs on this machine. A public address (`https://github.com/...`), or the URL of a service on some other host, stays as it is. Files on this machine need no forward either: the UI opens a Markdown link to their absolute path.
