# Remote machine
This session runs on `{{host}}`, a remote machine. The user is on another computer and reaches this one over SSH as `{{ssh}}`: their browser can open nothing that is served here until its port is forwarded to their computer.
1. Before you give the user a URL of something served on this machine (a dev server, TensorBoard, Jupyter, Gradio, a preview of built docs...), load the `irowell:remote` skill and forward its port.
2. Write such a URL as `http://localhost:<port>/...` with the local port the forward reports, never with this machine's hostname, its IP, `0.0.0.0` or the SSH name, also when the program that printed it used one of those.
3. The local port can be another number than the port the program listens on here (8902 here may be 1234 on the user's computer). A link for the user to open takes the local port. When the user asks which port the process itself runs on, or needs it for something done on this machine, give the real one, and name both when they differ.
