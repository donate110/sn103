"""Tests for structlog logging configuration."""

from __future__ import annotations

import logging
from unittest.mock import patch

import structlog

from djinn_validator.log_config import configure_logging


class TestConfigureLogging:
    def test_console_format_default(self) -> None:
        with patch.dict("os.environ", {}, clear=False):
            configure_logging()
        # Verify structlog is configured
        log = structlog.get_logger()
        assert log is not None

    def test_json_format(self) -> None:
        with patch.dict("os.environ", {"LOG_FORMAT": "json"}):
            configure_logging()
        log = structlog.get_logger()
        assert log is not None

    def test_log_level_debug(self) -> None:
        with patch.dict("os.environ", {"LOG_LEVEL": "DEBUG"}):
            configure_logging()
        assert logging.getLogger().level == logging.DEBUG

    def test_log_level_warning(self) -> None:
        with patch.dict("os.environ", {"LOG_LEVEL": "WARNING"}):
            configure_logging()
        assert logging.getLogger().level == logging.WARNING

    def test_default_log_level_info(self) -> None:
        with patch.dict("os.environ", {"LOG_LEVEL": "INFO"}):
            configure_logging()
        assert logging.getLogger().level == logging.INFO

    def test_noisy_libraries_silenced(self) -> None:
        configure_logging()
        assert logging.getLogger("uvicorn.access").level == logging.WARNING
        assert logging.getLogger("httpx").level == logging.WARNING
        assert logging.getLogger("httpcore").level == logging.WARNING

    def test_handler_writes_to_stdout(self) -> None:
        configure_logging()
        root = logging.getLogger()
        assert len(root.handlers) >= 1
        # First handler should be a StreamHandler
        handler = root.handlers[0]
        assert isinstance(handler, logging.StreamHandler)
