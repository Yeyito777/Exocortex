#include <X11/Xlib.h>
#include <X11/Xlibint.h>
#include <X11/Xutil.h>
#include <X11/Xproto.h>
#include <X11/keysym.h>
#include <ctype.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define EXOCORTEX_EXTENSION_NAME "EXOCORTEX-AUTOINPUT"
#define X_ExocortexTrustedSendEvent 1

typedef struct {
    CARD8 reqType;
    CARD8 exocortexReqType;
    CARD16 length;
    CARD16 tokenLen;
    CARD16 pad0;
    uint32_t destination;
    uint32_t eventMask;
    xEvent event;
} xExocortexTrustedSendEventReq;

static int exocortex_major_opcode = -2;

static const char *exocortex_token(void) {
    static char token[65536];
    static char fallback_path[128];
    const char *env_token = getenv("EXOCORTEX_XORG_INPUT_TOKEN");
    const char *path;
    FILE *f;
    size_t n;

    if (env_token && *env_token) return env_token;

    path = getenv("EXOCORTEX_XORG_INPUT_TOKEN_FILE");
    if (!path || !*path) {
        const char *runtime = getenv("XDG_RUNTIME_DIR");
        if (runtime && *runtime) {
            snprintf(fallback_path, sizeof(fallback_path), "%s/exocortex-xorg-input-token", runtime);
        } else {
            snprintf(fallback_path, sizeof(fallback_path), "/run/user/%lu/exocortex-xorg-input-token", (unsigned long)getuid());
        }
        path = fallback_path;
    }

    f = fopen(path, "rb");
    if (!f) return NULL;
    n = fread(token, 1, sizeof(token) - 1, f);
    fclose(f);
    while (n > 0 && (token[n - 1] == '\n' || token[n - 1] == '\r' || token[n - 1] == ' ' || token[n - 1] == '\t')) n--;
    token[n] = '\0';
    return token[0] ? token : NULL;
}

static int exocortex_major(Display *dpy) {
    int event_base = 0, error_base = 0;
    if (exocortex_major_opcode != -2) return exocortex_major_opcode;
    if (XQueryExtension(dpy, EXOCORTEX_EXTENSION_NAME, &exocortex_major_opcode, &event_base, &error_base))
        return exocortex_major_opcode;
    exocortex_major_opcode = -1;
    return -1;
}

static int send_targeted_event(Display *dpy, Window destination, long event_mask, XEvent *ev) {
    const char *token = exocortex_token();
    size_t token_len, padded_token_len, total_len;
    xExocortexTrustedSendEventReq *req;

    if (!token || !*token || exocortex_major(dpy) < 0)
        return XSendEvent(dpy, destination, True, event_mask, ev);

    token_len = strlen(token);
    if (token_len > 0xffff)
        return XSendEvent(dpy, destination, True, event_mask, ev);
    padded_token_len = (token_len + 3) & ~(size_t)3;
    total_len = sizeof(xExocortexTrustedSendEventReq) + padded_token_len;

    LockDisplay(dpy);
    req = (xExocortexTrustedSendEventReq *) _XGetRequest(dpy, (CARD8) exocortex_major_opcode, total_len);
    req->exocortexReqType = X_ExocortexTrustedSendEvent;
    req->tokenLen = (CARD16) token_len;
    req->destination = (uint32_t) destination;
    req->eventMask = (uint32_t) event_mask;
    if (!_XEventToWire(dpy, ev, &req->event)) {
        UnlockDisplay(dpy);
        SyncHandle();
        return 0;
    }
    memcpy((char *) req + sizeof(xExocortexTrustedSendEventReq), token, token_len);
    UnlockDisplay(dpy);
    SyncHandle();
    return 1;
}

static Window root_window(Display *dpy) {
    return DefaultRootWindow(dpy);
}

static int parse_window(const char *s, Window *out) {
    char *end = NULL;
    unsigned long value = strtoul(s, &end, 0);
    if (end == s || value == 0) return 0;
    *out = (Window)value;
    return 1;
}

static int streqi(const char *a, const char *b) {
    while (*a && *b) {
        if (tolower((unsigned char)*a) != tolower((unsigned char)*b)) return 0;
        a++; b++;
    }
    return *a == '\0' && *b == '\0';
}

static int button_number(const char *button) {
    if (!button || !*button || streqi(button, "left")) return Button1;
    if (streqi(button, "middle")) return Button2;
    if (streqi(button, "right")) return Button3;
    if (streqi(button, "up")) return Button4;
    if (streqi(button, "down")) return Button5;
    if (streqi(button, "left-scroll") || streqi(button, "scroll-left")) return 6;
    if (streqi(button, "right-scroll") || streqi(button, "scroll-right")) return 7;
    return atoi(button);
}

static int lookup_child_at(Display *dpy, Window w, int x, int y, Window *out, int *outx, int *outy) {
    Window root, parent, *children = NULL;
    unsigned int nchildren = 0;
    int i;

    *out = w;
    *outx = x;
    *outy = y;

    if (!XQueryTree(dpy, w, &root, &parent, &children, &nchildren)) return 1;

    /* XQueryTree returns children from bottom to top; walk topmost first. */
    for (i = (int)nchildren - 1; i >= 0; i--) {
        XWindowAttributes a;
        if (!XGetWindowAttributes(dpy, children[i], &a)) continue;
        if (a.map_state != IsViewable) continue;
        if (x >= a.x && y >= a.y && x < a.x + a.width && y < a.y + a.height) {
            Window child = children[i];
            int childx = x - a.x;
            int childy = y - a.y;
            if (children) XFree(children);
            return lookup_child_at(dpy, child, childx, childy, out, outx, outy);
        }
    }
    if (children) XFree(children);
    return 1;
}

static int window_center(Display *dpy, Window w, int *x, int *y) {
    XWindowAttributes a;
    if (!XGetWindowAttributes(dpy, w, &a)) return 0;
    *x = a.width / 2;
    *y = a.height / 2;
    return 1;
}

static int root_coords(Display *dpy, Window w, int x, int y, int *rx, int *ry) {
    Window child;
    return XTranslateCoordinates(dpy, w, root_window(dpy), x, y, rx, ry, &child);
}

static int send_motion(Display *dpy, Window w, int x, int y, unsigned int state) {
    XEvent ev;
    int rx = 0, ry = 0;
    memset(&ev, 0, sizeof(ev));
    root_coords(dpy, w, x, y, &rx, &ry);
    ev.xmotion.type = MotionNotify;
    ev.xmotion.display = dpy;
    ev.xmotion.window = w;
    ev.xmotion.root = root_window(dpy);
    ev.xmotion.subwindow = None;
    ev.xmotion.time = CurrentTime;
    ev.xmotion.x = x;
    ev.xmotion.y = y;
    ev.xmotion.x_root = rx;
    ev.xmotion.y_root = ry;
    ev.xmotion.state = state;
    ev.xmotion.is_hint = NotifyNormal;
    ev.xmotion.same_screen = True;
    return send_targeted_event(dpy, w, PointerMotionMask, &ev);
}

static int send_button(Display *dpy, Window w, int x, int y, int button, int press, unsigned int state) {
    XEvent ev;
    int rx = 0, ry = 0;
    memset(&ev, 0, sizeof(ev));
    root_coords(dpy, w, x, y, &rx, &ry);
    ev.xbutton.type = press ? ButtonPress : ButtonRelease;
    ev.xbutton.display = dpy;
    ev.xbutton.window = w;
    ev.xbutton.root = root_window(dpy);
    ev.xbutton.subwindow = None;
    ev.xbutton.time = CurrentTime;
    ev.xbutton.x = x;
    ev.xbutton.y = y;
    ev.xbutton.x_root = rx;
    ev.xbutton.y_root = ry;
    ev.xbutton.state = state;
    ev.xbutton.button = (unsigned int)button;
    ev.xbutton.same_screen = True;
    return send_targeted_event(dpy, w, press ? ButtonPressMask : ButtonReleaseMask, &ev);
}

static int send_click(Display *dpy, Window top, int x, int y, int button, int count) {
    Window target;
    int tx, ty, i;
    if (!lookup_child_at(dpy, top, x, y, &target, &tx, &ty)) return 0;
    send_motion(dpy, target, tx, ty, 0);
    for (i = 0; i < count; i++) {
        send_button(dpy, target, tx, ty, button, 1, 0);
        XFlush(dpy);
        usleep(30000);
        send_button(dpy, target, tx, ty, button, 0, (unsigned int)(1U << (button + 7)));
        XFlush(dpy);
        usleep(50000);
    }
    XSync(dpy, False);
    return 1;
}

static unsigned int modifier_mask(const char *name) {
    if (streqi(name, "ctrl") || streqi(name, "control")) return ControlMask;
    if (streqi(name, "shift")) return ShiftMask;
    if (streqi(name, "alt") || streqi(name, "option") || streqi(name, "mod1")) return Mod1Mask;
    if (streqi(name, "super") || streqi(name, "cmd") || streqi(name, "command") || streqi(name, "meta") || streqi(name, "mod4")) return Mod4Mask;
    return 0;
}

static KeySym modifier_keysym(unsigned int mask) {
    if (mask == ControlMask) return XK_Control_L;
    if (mask == ShiftMask) return XK_Shift_L;
    if (mask == Mod1Mask) return XK_Alt_L;
    if (mask == Mod4Mask) return XK_Super_L;
    return NoSymbol;
}

static KeySym key_alias(const char *name) {
    if (streqi(name, "enter")) return XK_Return;
    if (streqi(name, "return")) return XK_Return;
    if (streqi(name, "escape") || streqi(name, "esc")) return XK_Escape;
    if (streqi(name, "backspace")) return XK_BackSpace;
    if (streqi(name, "tab")) return XK_Tab;
    if (streqi(name, "space")) return XK_space;
    if (streqi(name, "delete") || streqi(name, "del")) return XK_Delete;
    if (streqi(name, "up")) return XK_Up;
    if (streqi(name, "down")) return XK_Down;
    if (streqi(name, "left")) return XK_Left;
    if (streqi(name, "right")) return XK_Right;
    if (streqi(name, "home")) return XK_Home;
    if (streqi(name, "end")) return XK_End;
    if (streqi(name, "pageup") || streqi(name, "prior")) return XK_Page_Up;
    if (streqi(name, "pagedown") || streqi(name, "next")) return XK_Page_Down;
    return XStringToKeysym(name);
}

static int send_key_event(Display *dpy, Window w, KeySym ks, unsigned int state, int press) {
    XEvent ev;
    KeyCode kc = XKeysymToKeycode(dpy, ks);
    if (!kc) return 0;
    memset(&ev, 0, sizeof(ev));
    ev.xkey.type = press ? KeyPress : KeyRelease;
    ev.xkey.display = dpy;
    ev.xkey.window = w;
    ev.xkey.root = root_window(dpy);
    ev.xkey.subwindow = None;
    ev.xkey.time = CurrentTime;
    ev.xkey.x = 0;
    ev.xkey.y = 0;
    ev.xkey.x_root = 0;
    ev.xkey.y_root = 0;
    ev.xkey.state = state;
    ev.xkey.keycode = kc;
    ev.xkey.same_screen = True;
    return send_targeted_event(dpy, w, press ? KeyPressMask : KeyReleaseMask, &ev);
}

static int send_key_with_state(Display *dpy, Window w, KeySym ks, unsigned int state) {
    unsigned int masks[] = { ControlMask, ShiftMask, Mod1Mask, Mod4Mask };
    unsigned int i, active = 0;
    for (i = 0; i < sizeof(masks) / sizeof(masks[0]); i++) {
        if (state & masks[i]) {
            KeySym mks = modifier_keysym(masks[i]);
            if (mks != NoSymbol) {
                send_key_event(dpy, w, mks, active, 1);
                active |= masks[i];
            }
        }
    }
    send_key_event(dpy, w, ks, state, 1);
    XFlush(dpy);
    usleep(10000);
    send_key_event(dpy, w, ks, state, 0);
    for (i = sizeof(masks) / sizeof(masks[0]); i > 0; i--) {
        if (state & masks[i - 1]) {
            KeySym mks = modifier_keysym(masks[i - 1]);
            if (mks != NoSymbol) {
                active &= ~masks[i - 1];
                send_key_event(dpy, w, mks, active, 0);
            }
        }
    }
    XSync(dpy, False);
    return 1;
}

static int char_keysym(char c, KeySym *ks, unsigned int *state) {
    *state = 0;
    if (c >= 'a' && c <= 'z') { *ks = (KeySym)c; return 1; }
    if (c >= 'A' && c <= 'Z') { *ks = (KeySym)tolower((unsigned char)c); *state = ShiftMask; return 1; }
    if (c >= '0' && c <= '9') { *ks = (KeySym)c; return 1; }
    switch (c) {
    case ' ': *ks = XK_space; return 1;
    case '\n': *ks = XK_Return; return 1;
    case '\t': *ks = XK_Tab; return 1;
    case '-': *ks = XK_minus; return 1;
    case '_': *ks = XK_minus; *state = ShiftMask; return 1;
    case '=': *ks = XK_equal; return 1;
    case '+': *ks = XK_equal; *state = ShiftMask; return 1;
    case '[': *ks = XK_bracketleft; return 1;
    case '{': *ks = XK_bracketleft; *state = ShiftMask; return 1;
    case ']': *ks = XK_bracketright; return 1;
    case '}': *ks = XK_bracketright; *state = ShiftMask; return 1;
    case '\\': *ks = XK_backslash; return 1;
    case '|': *ks = XK_backslash; *state = ShiftMask; return 1;
    case ';': *ks = XK_semicolon; return 1;
    case ':': *ks = XK_semicolon; *state = ShiftMask; return 1;
    case '\'': *ks = XK_apostrophe; return 1;
    case '"': *ks = XK_apostrophe; *state = ShiftMask; return 1;
    case ',': *ks = XK_comma; return 1;
    case '<': *ks = XK_comma; *state = ShiftMask; return 1;
    case '.': *ks = XK_period; return 1;
    case '>': *ks = XK_period; *state = ShiftMask; return 1;
    case '/': *ks = XK_slash; return 1;
    case '?': *ks = XK_slash; *state = ShiftMask; return 1;
    case '`': *ks = XK_grave; return 1;
    case '~': *ks = XK_grave; *state = ShiftMask; return 1;
    case '!': *ks = XK_1; *state = ShiftMask; return 1;
    case '@': *ks = XK_2; *state = ShiftMask; return 1;
    case '#': *ks = XK_3; *state = ShiftMask; return 1;
    case '$': *ks = XK_4; *state = ShiftMask; return 1;
    case '%': *ks = XK_5; *state = ShiftMask; return 1;
    case '^': *ks = XK_6; *state = ShiftMask; return 1;
    case '&': *ks = XK_7; *state = ShiftMask; return 1;
    case '*': *ks = XK_8; *state = ShiftMask; return 1;
    case '(': *ks = XK_9; *state = ShiftMask; return 1;
    case ')': *ks = XK_0; *state = ShiftMask; return 1;
    default: return 0;
    }
}

static int send_combo(Display *dpy, Window w, const char *combo) {
    char buf[128];
    char *parts[16];
    char *p;
    int n = 0, i;
    unsigned int state = 0;
    KeySym ks;

    snprintf(buf, sizeof(buf), "%s", combo);
    p = strtok(buf, "+");
    while (p && n < 16) {
        while (*p && isspace((unsigned char)*p)) p++;
        parts[n++] = p;
        p = strtok(NULL, "+");
    }
    if (n == 0) return 0;
    for (i = 0; i < n - 1; i++) state |= modifier_mask(parts[i]);
    if (strlen(parts[n - 1]) == 1) {
        char c = parts[n - 1][0];
        unsigned int char_state = 0;
        /* Shortcut notation commonly writes Ctrl+L / Alt+F with uppercase
         * letters for readability.  Do not turn that into Ctrl+Shift+L unless
         * Shift was explicitly requested. */
        if ((state & (ControlMask|Mod1Mask|Mod4Mask)) && !(state & ShiftMask) && c >= 'A' && c <= 'Z')
            c = (char)tolower((unsigned char)c);
        if (!char_keysym(c, &ks, &char_state)) return 0;
        state |= char_state;
    } else {
        ks = key_alias(parts[n - 1]);
        if (ks == NoSymbol) return 0;
    }
    return send_key_with_state(dpy, w, ks, state);
}

static int send_text(Display *dpy, Window w, const char *text) {
    const unsigned char *p;
    /* Give clients a short moment after the helper connects/targets the window.
     * Without this, some terminals accept the later key events but drop the
     * first burst of characters. */
    XSync(dpy, False);
    usleep(90000);
    for (p = (const unsigned char *)text; *p; p++) {
        KeySym ks;
        unsigned int state;
        if (*p > 0x7f || !char_keysym((char)*p, &ks, &state)) {
            fprintf(stderr, "unsupported character for direct X11 text typing: U+%02x\n", *p);
            return 0;
        }
        send_key_with_state(dpy, w, ks, state);
        usleep(22000);
    }
    XSync(dpy, False);
    usleep(40000);
    return 1;
}

static int send_scroll(Display *dpy, Window top, const char *direction, int pages, int x, int y) {
    int button = Button5;
    int i;
    if (streqi(direction, "up")) button = Button4;
    else if (streqi(direction, "down")) button = Button5;
    else if (streqi(direction, "left")) button = 6;
    else if (streqi(direction, "right")) button = 7;
    for (i = 0; i < pages; i++) send_click(dpy, top, x, y, button, 1);
    return 1;
}

static int send_drag(Display *dpy, Window top, int x1, int y1, int x2, int y2) {
    Window target;
    int tx1, ty1, tx2, ty2;
    int i, steps = 12;
    int dx = x2 - x1, dy = y2 - y1;
    if (!lookup_child_at(dpy, top, x1, y1, &target, &tx1, &ty1)) return 0;
    /* Keep the same child target; translate destination by the same top-level offset. */
    tx2 = tx1 + dx;
    ty2 = ty1 + dy;
    send_motion(dpy, target, tx1, ty1, 0);
    send_button(dpy, target, tx1, ty1, Button1, 1, 0);
    for (i = 1; i <= steps; i++) {
        int x = tx1 + (dx * i) / steps;
        int y = ty1 + (dy * i) / steps;
        send_motion(dpy, target, x, y, Button1Mask);
        XFlush(dpy);
        usleep(10000);
    }
    send_button(dpy, target, tx2, ty2, Button1, 0, Button1Mask);
    XSync(dpy, False);
    return 1;
}

static void usage(const char *argv0) {
    fprintf(stderr,
        "usage:\n"
        "  %s probe\n"
        "  %s click <win> <x> <y> <button> <count>\n"
        "  %s scroll <win> <direction> <pages> <x> <y>\n"
        "  %s key <win> <key-combo>\n"
        "  %s type <win> <text>\n"
        "  %s drag <win> <from_x> <from_y> <to_x> <to_y>\n",
        argv0, argv0, argv0, argv0, argv0, argv0);
}

int main(int argc, char **argv) {
    Display *dpy;
    Window win;
    const char *cmd;
    int ok = 0;

    if (argc >= 2 && streqi(argv[1], "probe")) {
        dpy = XOpenDisplay(NULL);
        if (!dpy) {
            fprintf(stderr, "cannot open X display\n");
            return 1;
        }
        ok = exocortex_major(dpy) >= 0 && exocortex_token();
        printf("trusted_input=%s\n", ok ? "available" : "unavailable");
        XCloseDisplay(dpy);
        return ok ? 0 : 1;
    }
    if (argc < 3) { usage(argv[0]); return 2; }
    cmd = argv[1];
    if (!parse_window(argv[2], &win)) {
        fprintf(stderr, "invalid window id: %s\n", argv[2]);
        return 2;
    }
    dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fprintf(stderr, "cannot open X display\n");
        return 1;
    }

    if (streqi(cmd, "click")) {
        if (argc < 7) usage(argv[0]);
        else ok = send_click(dpy, win, atoi(argv[3]), atoi(argv[4]), button_number(argv[5]), atoi(argv[6]));
    } else if (streqi(cmd, "scroll")) {
        int x = 0, y = 0;
        if (argc < 5) usage(argv[0]);
        else {
            if (argc >= 7) { x = atoi(argv[5]); y = atoi(argv[6]); }
            else window_center(dpy, win, &x, &y);
            ok = send_scroll(dpy, win, argv[3], atoi(argv[4]), x, y);
        }
    } else if (streqi(cmd, "key")) {
        if (argc < 4) usage(argv[0]);
        else ok = send_combo(dpy, win, argv[3]);
    } else if (streqi(cmd, "type")) {
        if (argc < 4) usage(argv[0]);
        else ok = send_text(dpy, win, argv[3]);
    } else if (streqi(cmd, "drag")) {
        if (argc < 7) usage(argv[0]);
        else ok = send_drag(dpy, win, atoi(argv[3]), atoi(argv[4]), atoi(argv[5]), atoi(argv[6]));
    } else {
        usage(argv[0]);
    }

    XCloseDisplay(dpy);
    return ok ? 0 : 1;
}
