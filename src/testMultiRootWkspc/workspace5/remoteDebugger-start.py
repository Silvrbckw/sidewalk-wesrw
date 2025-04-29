import sys
import time

def main():
    sys.stdout.write('this is stdout')
    sys.stdout.flush()
    sys.stderr.write('this is stderr')
    sys.stderr.flush()
    # Give the debugger some time to add a breakpoint.
    time.sleep(5)
    for _ in range(1):
        time.sleep(0.5)
    print('this is print')

main()
