# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import json
import sys

obj = {
    "versionInfo": tuple(sys.version_info),
    "sysPrefix": sys.prefix,
    "sysVersion": sys.version,
    "is64Bit": sys.maxsize > 2**32,
}
print(json.dumps(obj))
