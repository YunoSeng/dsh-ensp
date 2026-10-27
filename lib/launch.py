"""Launch the eNSP bridge elevated, without needing an elevated caller.

``python launch.py --bridge <bridge.py> --python <pythonw.exe> --job <job.json>``

Runs under a normal (low integrity) interpreter: ``ShellExecuteW`` with the
"runas" verb asks Windows to start the bridge elevated.  On a machine where UAC
auto-approves administrators (ConsentPromptBehaviorAdmin=0) this is silent; on
others the user sees one prompt per batch, which is why the plugin prefers a
resident bridge when it can keep one alive.
"""

import argparse
import ctypes
import os
import sys


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--job", default="")
    parser.add_argument("--args", default="")
    args = parser.parse_args(argv)

    if args.job:
        params = '"%s" --job "%s"' % (args.bridge, args.job)
    else:
        params = '"%s" %s' % (args.bridge, args.args)
    workdir = os.path.dirname(os.path.abspath(args.bridge))
    rc = ctypes.windll.shell32.ShellExecuteW(None, "runas", args.python, params, workdir, 0)
    # ShellExecute returns >32 on success; the child runs detached either way.
    print(rc)
    return 0 if rc > 32 else 1


if __name__ == "__main__":
    sys.exit(main())
