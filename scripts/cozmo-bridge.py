#!/usr/bin/env python3
"""
HoboStreamer — Cozmo Hardware Bridge

Connects to the HoboStreamer Control WebSocket as a hardware client,
translates incoming commands into pycozmo actions on a physical Cozmo robot.

Requirements:
    pip install pycozmo websocket-client

Usage:
    python3 cozmo-bridge.py --url ws://localhost:3000/ws/control --stream-key YOUR_STREAM_KEY

Environment Variables (alternative to CLI args):
    HOBO_WS_URL        WebSocket URL  (default: ws://localhost:3000/ws/control)
    HOBO_STREAM_KEY    Stream key for authentication

Supported commands (sent from HoboStreamer control panel):
    forward, backward, turn_left, turn_right,
    lift_up, lift_down, head_up, head_down,
    say:<text>, anim:<trigger>
"""

import argparse
import json
import os
import sys
import threading
import time
import traceback

try:
    import pycozmo
except ImportError:
    pycozmo = None

try:
    import websocket
except ImportError:
    websocket = None


# ── Command → Cozmo Action Mapping ───────────────────────────

DRIVE_SPEED = 100       # mm/s
TURN_SPEED = 80         # mm/s differential
DRIVE_DURATION = 0.4    # seconds
LIFT_SPEED = 3.0        # rad/s
HEAD_SPEED = 1.0        # rad/s
MOVE_DURATION = 0.3     # seconds for lift/head


def handle_command(cli, command_str):
    """Translate a HoboStreamer control command to a pycozmo action."""
    cmd = command_str.strip().lower()

    if cmd == 'forward':
        cli.drive_wheels(DRIVE_SPEED, DRIVE_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'backward':
        cli.drive_wheels(-DRIVE_SPEED, -DRIVE_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'turn_left':
        cli.drive_wheels(-TURN_SPEED, TURN_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'turn_right':
        cli.drive_wheels(TURN_SPEED, -TURN_SPEED, duration=DRIVE_DURATION)
    elif cmd == 'lift_up':
        cli.move_lift(LIFT_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_lift(0.0)
    elif cmd == 'lift_down':
        cli.move_lift(-LIFT_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_lift(0.0)
    elif cmd == 'head_up':
        cli.move_head(HEAD_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_head(0.0)
    elif cmd == 'head_down':
        cli.move_head(-HEAD_SPEED)
        time.sleep(MOVE_DURATION)
        cli.move_head(0.0)
    elif cmd.startswith('say:'):
        text = command_str[4:].strip()[:200]
        if text:
            cli.say(text)
    elif cmd.startswith('anim:'):
        trigger = command_str[5:].strip()
        try:
            cli.play_anim_trigger(getattr(pycozmo.anim.Triggers, trigger))
        except AttributeError:
            print(f'[Cozmo] Unknown animation trigger: {trigger}')
    else:
        print(f'[Cozmo] Unknown command: {cmd}')
        return False

    return True


# ── WebSocket Client ──────────────────────────────────────────

class CozmoHardwareBridge:
    """Bridges HoboStreamer control WebSocket ↔ physical Cozmo robot."""

    def __init__(self, ws_url, stream_key):
        self.ws_url = ws_url
        self.stream_key = stream_key
        self.ws = None
        self.cozmo_cli = None
        self.running = False
        self._reconnect_delay = 2

    def connect_cozmo(self):
        """Connect to Cozmo over BLE via pycozmo."""
        if pycozmo is None:
            print('[Cozmo] pycozmo not installed — running in DRY RUN mode')
            print('[Cozmo] Install with: pip install pycozmo')
            return None

        print('[Cozmo] Connecting to Cozmo robot...')
        cli = pycozmo.Client()
        cli.start()
        cli.connect()
        cli.wait_for_robot()
        print('[Cozmo] Robot connected')
        return cli

    def send_status(self, status_data):
        """Send a status update back to HoboStreamer."""
        if self.ws:
            try:
                self.ws.send(json.dumps({'type': 'status', **status_data}))
            except Exception:
                pass

    def on_ws_message(self, ws, raw):
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return

        if msg.get('type') == 'connected':
            print(f'[WS] Registered as hardware client')
            self.send_status({'cozmo': 'connected' if self.cozmo_cli else 'dry_run'})
            return

        if msg.get('type') == 'command':
            cmd = msg.get('command', '')
            user = msg.get('from_user', '?')
            print(f'[CMD] {user} → {cmd}')

            if self.cozmo_cli:
                try:
                    handle_command(self.cozmo_cli, cmd)
                except Exception as e:
                    print(f'[Cozmo] Command error: {e}')
                    self.send_status({'error': str(e)})
            else:
                # Dry-run mode — just log
                print(f'[DRY RUN] Would execute: {cmd}')

    def on_ws_error(self, ws, error):
        print(f'[WS] Error: {error}')

    def on_ws_close(self, ws, code, reason):
        print(f'[WS] Disconnected (code={code})')

    def on_ws_open(self, ws):
        print(f'[WS] Connected to {self.ws_url}')

    def run(self):
        """Main loop: connect to Cozmo, then maintain WS connection."""
        if websocket is None:
            print('[ERROR] websocket-client not installed')
            print('Install with: pip install websocket-client')
            sys.exit(1)

        self.running = True

        # Connect to Cozmo first
        try:
            self.cozmo_cli = self.connect_cozmo()
        except Exception as e:
            print(f'[Cozmo] Connection failed: {e} — continuing in DRY RUN mode')
            self.cozmo_cli = None

        # WebSocket reconnect loop
        while self.running:
            try:
                url = f'{self.ws_url}?mode=hardware&stream_key={self.stream_key}'
                self.ws = websocket.WebSocketApp(
                    url,
                    on_open=self.on_ws_open,
                    on_message=self.on_ws_message,
                    on_error=self.on_ws_error,
                    on_close=self.on_ws_close,
                )
                self.ws.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as e:
                print(f'[WS] Connection failed: {e}')

            if self.running:
                print(f'[WS] Reconnecting in {self._reconnect_delay}s...')
                time.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 2, 30)

    def stop(self):
        self.running = False
        if self.ws:
            self.ws.close()
        if self.cozmo_cli:
            try:
                self.cozmo_cli.disconnect()
                self.cozmo_cli.stop()
            except Exception:
                pass


# ── CLI Entry Point ───────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='HoboStreamer Cozmo Hardware Bridge')
    parser.add_argument('--url', default=os.environ.get('HOBO_WS_URL', 'ws://localhost:3000/ws/control'),
                        help='HoboStreamer control WebSocket URL')
    parser.add_argument('--stream-key', default=os.environ.get('HOBO_STREAM_KEY', ''),
                        help='Stream key for authentication')
    args = parser.parse_args()

    if not args.stream_key:
        print('[ERROR] Stream key required. Use --stream-key or set HOBO_STREAM_KEY')
        sys.exit(1)

    bridge = CozmoHardwareBridge(args.url, args.stream_key)

    try:
        bridge.run()
    except KeyboardInterrupt:
        print('\n[Bridge] Shutting down...')
        bridge.stop()


if __name__ == '__main__':
    main()
