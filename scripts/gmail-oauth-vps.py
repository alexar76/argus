#!/usr/bin/env python3
"""Run Gmail OAuth setup using a running ARGUS container's configuration and state."""

import argparse
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile


MAX_CLIENT_FILE_BYTES = 16 * 1024
STATE_ENV = ("HOME", "ARGUS_CONFIG", "ARGUS_HOME", "ARGUS_STATE_DIR")
PASSPHRASE_ENV = "ARGUS_KEYSTORE_PASSPHRASE"
CLIENT_MOUNT = "/tmp/argus-gmail-client.json"


class SetupError(Exception):
    pass


def parse_port(value):
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("choose a port from 1024 to 65535") from error
    if not 1024 <= port <= 65535:
        raise argparse.ArgumentTypeError("choose a port from 1024 to 65535")
    return port


def docker_output(*arguments):
    try:
        result = subprocess.run(
            ["docker", *arguments], capture_output=True, text=True, check=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as error:
        # Docker inspect and its errors may contain the running container's environment.
        raise SetupError("Could not inspect the running ARGUS container through Docker.") from error
    return result.stdout


def running_configuration(container):
    try:
        [details] = json.loads(docker_output("container", "inspect", container))
        if details["State"]["Running"] is not True:
            raise SetupError("The selected ARGUS container is not running.")
        config = details["Config"]
        image = details["Image"]
        workdir = config["WorkingDir"]
        if not isinstance(workdir, str) or not workdir.startswith("/"):
            raise SetupError("The ARGUS container must have an absolute working directory.")
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", image):
            raise SetupError("Docker did not report an immutable image ID for this container.")
        allowed = (*STATE_ENV, PASSPHRASE_ENV)
        env = {}
        for setting in config.get("Env") or []:
            name, separator, value = setting.partition("=")
            if separator and name in allowed:
                env[name] = value
        if not env.get(PASSPHRASE_ENV, "").strip():
            raise SetupError(f"The running ARGUS container requires {PASSPHRASE_ENV} in its environment.")
        command = details.get("Args") or []
        config_flag = []
        if "--config" in command:
            index = command.index("--config") + 1
            if index == len(command) or not command[index] or command[index].startswith("--"):
                raise SetupError("The running ARGUS command has an invalid --config option.")
            config_flag = ["--config", command[index]]
        uid = int(docker_output("exec", container, "id", "-u"))
        gid = int(docker_output("exec", container, "id", "-g"))
        user = config.get("User") or f"{uid}:{gid}"
    except (KeyError, TypeError, ValueError) as error:
        raise SetupError("Docker returned an unexpected ARGUS configuration.") from error
    return image, workdir, user, uid, gid, env, config_flag


def stage_client_file(source, destination, uid, gid):
    try:
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
        with os.fdopen(os.open(source, flags), "rb") as client:
            metadata = os.fstat(client.fileno())
            if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o600:
                raise SetupError("The downloaded OAuth JSON must be a regular file with mode 0600.")
            if not 0 < metadata.st_size <= MAX_CLIENT_FILE_BYTES:
                raise SetupError("The downloaded OAuth JSON must be nonempty and at most 16 KiB.")
            contents = client.read(MAX_CLIENT_FILE_BYTES + 1)
            if not 0 < len(contents) <= MAX_CLIENT_FILE_BYTES:
                raise SetupError("The downloaded OAuth JSON changed size during the read.")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        with os.fdopen(os.open(destination, flags, 0o600), "wb") as staged:
            os.fchmod(staged.fileno(), 0o600)
            os.fchown(staged.fileno(), uid, gid)
            staged.write(contents)
    except OSError as error:
        raise SetupError("Could not prepare the private OAuth JSON for the ARGUS user.") from error


def run_setup(args):
    image, workdir, user, uid, gid, env, config_flag = running_configuration(args.container)
    with tempfile.TemporaryDirectory(prefix="argus-gmail-oauth-", dir="/tmp") as directory:
        staged = Path(directory) / "client.json"
        cidfile = Path(directory) / "container-id"
        stage_client_file(args.client, staged, uid, gid)
        command = [
            "docker", "run", "--rm", "-it", "--network", "host",
            "--cidfile", str(cidfile), "--log-driver", "none",
            "--volumes-from", args.container, "--user", user, "--workdir", workdir,
            "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
            "--mount", f"type=bind,source={staged},target={CLIENT_MOUNT},readonly",
            "--entrypoint", "node",
        ]
        for name in env:
            command.extend(("--env", name))
        command.extend((
            image, "dist/index.js", "mail", "setup", "--gmail-client", CLIENT_MOUNT,
            "--oauth-port", str(args.port), *config_flag,
        ))
        if args.force:
            command.append("--force")
        if args.gmail_send_api:
            command.append("--gmail-send-api")
        if args.incoming_only:
            command.append("--incoming-only")
        try:
            return subprocess.run(command, env={**os.environ, **env}, check=False).returncode
        finally:
            # SSH can close before Docker finishes stopping the attached wizard.
            if cidfile.exists():
                container_id = cidfile.read_text().strip()
                if re.fullmatch(r"[0-9a-f]{64}", container_id):
                    subprocess.run(["docker", "rm", "-f", container_id], stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, check=False, timeout=15)


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client", type=Path, help="private downloaded Google Desktop app OAuth JSON")
    parser.add_argument("--container", default="argus", help="running ARGUS container (default: argus)")
    parser.add_argument("--port", type=parse_port, default=8765, help="loopback port for the SSH tunnel (default: 8765)")
    parser.add_argument("--force", action="store_true", help="replace the existing ARGUS mailbox and reset its permissions")
    transport = parser.add_mutually_exclusive_group()
    transport.add_argument("--gmail-send-api", action="store_true", help="send through the Gmail API over HTTPS instead of SMTP")
    transport.add_argument("--incoming-only", action="store_true", help="connect IMAP without a sending transport")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", args.container):
        parser.error("use a Docker container name or ID")
    if os.geteuid() != 0 or not sys.stdin.isatty() or not sys.stdout.isatty():
        parser.error("run as root on the Docker host in a private interactive terminal")
    signal.signal(signal.SIGHUP, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        return run_setup(args)
    except SetupError as error:
        print(f"Gmail OAuth setup: {error}", file=sys.stderr)
        return 1
    except OSError:
        print("Gmail OAuth setup: could not launch the setup container.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
