#!/usr/bin/env python3
"""Host-only updater for a single fixed M365 Compose service.

Web UI writes an authenticated request to the existing /data bind mount.
This script runs as a systemd oneshot on the VPS. No Docker socket is mounted
inside the web-facing container. No URL, shell command or path comes from UI.
"""
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path('/root/M365_1.5')
DATA = Path('/opt/m365-console-v15/data')
CONFIG = Path('/opt/m365-console-v15/console.env')
UPDATES = DATA / 'updates'
REQUEST = UPDATES / 'request.json'
PROCESSING = UPDATES / 'processing.json'
STATUS = UPDATES / 'status.json'
RELEASE = UPDATES / 'release.json'
LOG = UPDATES / 'updater.log'
COMPOSE = 'compose.m365-iptest.yaml'
SERVICE = 'console'
IMAGE = 'local/m365-console:v1.5-http-test'
ROLLBACK = 'local/m365-console:web-updater-previous'
ALLOWED_REMOTES = {
    'https://github.com/noetes33/M365_1.5.git',
    'https://github.com/noetes33/M365_1.5',
    'git@github.com:noetes33/M365_1.5.git',
    'git@github.com:noetes33/M365_1.5',
}
BUSY = {'checking', 'backing-up', 'pulling', 'building', 'restarting', 'verifying'}

def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')

def read_json(file, default=None):
    try:
        return json.loads(file.read_text(encoding='utf-8'))
    except (FileNotFoundError, ValueError, OSError):
        return default if default is not None else {}

def atomic_json(file, value):
    tmp = file.with_name(file.name + '.tmp.' + str(os.getpid()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump(value, out, ensure_ascii=False, sort_keys=True)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, 0o644)
        os.replace(tmp, file)
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass

def write_status(phase, message, **extra):
    current = read_json(STATUS)
    current.update({'phase': phase, 'step': phase, 'message': message, 'updatedAt': utcnow()})
    current.update(extra)
    atomic_json(STATUS, current)
    print(f'{utcnow()} {phase}: {message}', flush=True)

def run(*args, cwd=ROOT, timeout=600):
    # Fixed command and argv only; never shell=True, never execute UI input.
    try:
        result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f'操作超时：{args[0]}') from exc
    if result.returncode:
        # Show the failing command, not its potentially sensitive full output.
        with LOG.open('a', encoding='utf-8') as out:
            out.write(f'{utcnow()} {args[0]} returned {result.returncode}\n')
            out.write(result.stdout[-16000:] if result.stdout else '')
            out.write('\n')
        raise RuntimeError(f'{args[0]} 执行失败（退出码 {result.returncode}）；详情见 VPS 更新日志')
    return result.stdout.strip()

def git(*args, timeout=100):
    return run('git', *args, timeout=timeout)

def check_paths():
    if not ROOT.is_dir() or not (ROOT / '.git').exists():
        raise RuntimeError('找不到固定的 M365 Git 目录')
    if not (ROOT / COMPOSE).is_file() or not DATA.is_dir() or not CONFIG.is_file():
        raise RuntimeError('M365 Compose 或数据目录不存在')
    if git('remote', 'get-url', 'origin') not in ALLOWED_REMOTES:
        raise RuntimeError('Git origin 不是指定的 M365 仓库，拒绝执行')

def health_ok():
    try:
        with urlopen('http://127.0.0.1:4142/health', timeout=4) as r:
            return r.status == 200
    except (URLError, TimeoutError, OSError):
        return False

def wait_health(seconds=150):
    for _ in range(seconds // 3):
        if health_ok():
            return True
        time.sleep(3)
    return False

def backup_data():
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    target = Path('/root') / f'm365-web-before-update-{stamp}.tar.gz'
    # Data is mounted outside the Docker image. No -v or prune operations.
    old_umask = os.umask(0o077)
    try:
        run('tar', '-czf', str(target), '-C', str(DATA.parent), 'data', 'console.env', cwd=Path('/'), timeout=300)
    finally:
        os.umask(old_umask)
    os.chmod(target, 0o600)
    return target

def initial_release():
    info = read_json(RELEASE)
    commit = info.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        return git('rev-parse', 'HEAD')
    return commit

def check_update():
    write_status('checking', '正在检查 GitHub main 最新提交…')
    installed = initial_release()
    line = git('ls-remote', 'origin', 'refs/heads/main', timeout=45)
    m = re.fullmatch(r'([0-9a-f]{40})\s+refs/heads/main', line)
    if not m:
        raise RuntimeError('无法取得远端 main 提交')
    remote = m.group(1)
    changed = installed != remote
    write_status('done', '检测到新版本' if changed else '已经是最新版本',
                 currentCommit=installed, remoteCommit=remote, updateAvailable=changed)

def apply_update():
    check_paths()
    installed = initial_release()
    write_status('checking', '正在检查 GitHub main…', currentCommit=installed)
    if git('status', '--porcelain'):
        raise RuntimeError('服务器源码有未提交的改动，未执行自动更新')
    write_status('pulling', '正在获取 GitHub 最新源码…')
    git('fetch', 'origin', 'main', timeout=160)
    remote = git('rev-parse', 'FETCH_HEAD')
    if not re.fullmatch(r'[0-9a-f]{40}', remote):
        raise RuntimeError('远端提交格式异常')
    if remote == installed and health_ok():
        write_status('done', '当前版本已经是最新版本', currentCommit=installed,
                     remoteCommit=remote, updateAvailable=False)
        return
    # Do not allow an update that would silently move to an unrelated history.
    local = git('rev-parse', 'HEAD')
    if local != remote:
        git('merge-base', '--is-ancestor', local, remote)
    write_status('backing-up', '正在备份 M365 数据与配置…', remoteCommit=remote)
    backup_data()
    write_status('pulling', '正在切换到最新代码…')
    if local != remote:
        git('merge', '--ff-only', 'FETCH_HEAD', timeout=90)
    # Previous VPS updates used umask 077; ensure UID 1000 may read app sources.
    run('find', 'packages/console', '-type', 'd', '-exec', 'chmod', 'a+rx', '{}', '+', timeout=60)
    run('find', 'packages/console', '-type', 'f', '-exec', 'chmod', 'a+r', '{}', '+', timeout=60)
    write_status('building', '正在构建 M365 Docker 镜像（不会更新其他服务）…')
    previous_image = None
    try:
        previous_image = run('docker', 'image', 'inspect', IMAGE, '--format', '{{.Id}}', timeout=20)
        run('docker', 'tag', previous_image, ROLLBACK, timeout=20)
    except RuntimeError:
        previous_image = None
    run('docker', 'compose', '-f', COMPOSE, 'build', SERVICE, timeout=1500)
    write_status('restarting', '新镜像已构建，正在重启 M365 容器…')
    run('docker', 'compose', '-f', COMPOSE, 'up', '-d', '--no-deps', '--force-recreate', '--no-build', SERVICE, timeout=180)
    write_status('verifying', '正在检查更新后的后台健康状态…')
    if not wait_health():
        if previous_image:
            # Restore the last running image while preserving mounted data.
            write_status('restarting', '新版本健康检查失败，正在恢复上一个镜像…')
            run('docker', 'tag', ROLLBACK, IMAGE, timeout=30)
            run('docker', 'compose', '-f', COMPOSE, 'up', '-d', '--no-deps', '--force-recreate', '--no-build', SERVICE, timeout=180)
            if not wait_health(60):
                raise RuntimeError('更新失败，回退后的服务健康检查也未通过')
            raise RuntimeError('新版本健康检查失败，已恢复上一镜像；账号数据未删除')
        raise RuntimeError('更新后的服务健康检查未通过')
    # Mark release only after a healthy service has started.
    atomic_json(RELEASE, {'commit': remote, 'updatedAt': utcnow()})
    write_status('done', 'M365 更新成功，服务已恢复', currentCommit=remote,
                 remoteCommit=remote, updateAvailable=False)

def main():
    UPDATES.mkdir(parents=True, exist_ok=True)
    lock_path = UPDATES / 'host-updater.lock'
    with lock_path.open('a+') as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        try:
            REQUEST.replace(PROCESSING)
        except FileNotFoundError:
            return 0
        req=read_json(PROCESSING)
        try:
            if (not isinstance(req, dict) or req.get('action') not in ('check','update')
                or not re.fullmatch(r'[0-9a-fA-F-]{36}', str(req.get('id','')))):
                raise RuntimeError('无效的更新任务请求')
            check_paths()
            if req['action'] == 'check':
                check_update()
            else:
                apply_update()
        except Exception as exc:
            write_status('failed', str(exc)[:240])
            return 1
        finally:
            PROCESSING.unlink(missing_ok=True)
        return 0

if __name__=='__main__':
    sys.exit(main())
