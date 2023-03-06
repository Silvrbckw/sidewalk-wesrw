# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

from __future__ import absolute_import

from ..errors import UnsupportedCommandError


def add_subparser(cmd, name, parent):
    """Add a new subparser to the given parent and add args to it."""
    parser = parent.add_parser(name)
    if cmd != "discover":
        raise UnsupportedCommandError(cmd)
    return parser
