# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import os
import sys
import subprocess

# This is a simple solution to waiting for completion of commands sent to terminal.
# 1. Intercept commands send to a terminal
# 2. Send commands to our script file with an additional argument
# 3. In here create a file that'll log the progress.
# 4. Calling code monitors the contents of the file to determine state of execution.

# Last argument is a file that's used for synchronizing the actions in the terminal with the calling code in extension.
lock_file = sys.argv[-1]
shell_args = sys.argv[1:-1]

print("Executing command in shell >> " + " ".join(shell_args))

with open(lock_file, "w") as fp:
    try:
        # Signal start of execution.
        fp.write("START\n")
        fp.flush()

        subprocess.check_call(shell_args, stdout=sys.stdout, stderr=sys.stderr)

        # Signal start of execution.
        fp.write("END\n")
        fp.flush()
    except Exception:
        import traceback

        print(traceback.format_exc())
        # Signal end of execution with failure state.
        fp.write("FAIL\n")
        fp.flush()
        try:
            # ALso log the error for use from the other side.
            with open(f"{lock_file}.error", "w") as fpError:
                fpError.write(traceback.format_exc())
        except Exception:
            pass
