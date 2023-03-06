import pytest
import unittest


def test_top_level():
    pass


@pytest.mark.skip
def test_skipped():
    assert False


class TestMySuite(object):

    def test_simple(self):
        pass


class MyTests(unittest.TestCase):

    def test_simple(self):
        pass

    @pytest.mark.skip
    def test_skipped(self):
        assert False
