import contextlib
import io
import unittest
from unittest import mock

from cli import support as asip_support


class SupportDiagnosticsTests(unittest.TestCase):
    def test_permission_guidance_handles_confined_agent_runner(self):
        stderr = io.StringIO()
        reader = mock.Mock(side_effect=PermissionError)
        with contextlib.redirect_stderr(stderr):
            result = asip_support.main(["preview"], summary_reader=reader)

        self.assertEqual(result, 77)
        message = stderr.getvalue()
        self.assertIn("fresh login or harness", message)
        self.assertIn("host context", message)
        self.assertIn("confined runner", message)
        self.assertIn("before ASIP starts", message)


if __name__ == "__main__":
    unittest.main()
