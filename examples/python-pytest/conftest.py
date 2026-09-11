"""
Point pytest at MFARM.

THIS FILE IS THE WHOLE ADOPTION CLAIM, IN A LANGUAGE THIS REPO HAS NEVER USED. Everything in
`test_medishop.py` is ordinary Appium that would run against a local emulator unchanged; this is the
part that points it at the farm, and it is a hostname, a credential and four capabilities.

It exists to answer one question with evidence rather than architecture: does a suite have to be
JavaScript or Java to run here? `examples/medishop-suite` is WebdriverIO and `examples/java-testng`
is a Java file. If Python works with no farm-side change, the hub is language-independent because it
speaks W3C WebDriver, and nothing about a language needs building.

ONE SESSION PER TEST, which is the LambdaTest shape — one Appium session per Cucumber scenario — and
the shape that makes `mfarm:name` worth having. `examples/medishop-suite` deliberately does the
opposite (one device per spec FILE) because allocation and powerwash cost real seconds; both are
legitimate and the farm does not care which you pick.
"""
import base64
import os
import time

import pytest
from appium import webdriver
from appium.options.android import UiAutomator2Options
from appium.webdriver.appium_connection import AppiumConnection

HUB = os.environ.get("MFARM_HUB", "https://farm.mfarm.dev") + "/wd/hub"
KEY = os.environ.get("MFARM_API_KEY")
REGION = os.environ.get("MFARM_REGION", "lab")
APP_ID = os.environ.get("MFARM_APP_ID", "com.way2automation.medishop@latest")

# `$GITHUB_RUN_ID` in CI. Locally there is no such variable and one is made up, which is exactly
# what a developer running this on a laptop wants: their own run, not somebody else's.
RUN_ID = os.environ.get("MFARM_RUN_ID") or os.environ.get("GITHUB_RUN_ID") or f"pytest-{int(time.time())}"
RUN_NAME = os.environ.get("MFARM_RUN_NAME") or f"MediShop_pytest_{time.strftime('%d_%m_%Y_%H_%M_%S')}"

CREDENTIALS = {"email": "trainer@way2automation.com", "password": "way2automation"}

if not KEY:
    raise RuntimeError("MFARM_API_KEY is required. Mint one in the console under Settings -> API keys.")


class _AuthConnection(AppiumConnection):
    """
    The API key as an Authorization header, NOT as userinfo in the URL.

    The same trap `farm.js` documents for WebdriverIO, in a different shape: several HTTP stacks
    quietly drop `https://key@host/...` credentials, and the farm then answers "Missing or invalid
    credentials" for a request that looked correct. Setting the header is the one spelling that
    cannot be silently discarded. The key is the Basic USERNAME and the password half stays empty.
    """

    def get_remote_connection_headers(self, parsed_url, keep_alive=True):
        headers = super().get_remote_connection_headers(parsed_url, keep_alive)
        headers["Authorization"] = "Basic " + base64.b64encode(f"{KEY}:".encode()).decode()
        return headers


def _options(test_name):
    opts = UiAutomator2Options()
    opts.set_capability("platformName", "Android")
    opts.set_capability("appium:automationName", "UiAutomator2")
    opts.set_capability("appium:autoGrantPermissions", True)
    # The farm installs and launches the build; this only says how long Appium waits between
    # commands before deciding the client has gone away.
    opts.set_capability("appium:newCommandTimeout", 300)

    opts.set_capability("mfarm:region", REGION)
    opts.set_capability("mfarm:appId", APP_ID)
    opts.set_capability("mfarm:runId", RUN_ID)
    opts.set_capability("mfarm:runName", RUN_NAME)
    # The test, at creation. This is what makes the console legible WHILE the test runs, rather
    # than after it posts a result -- see ADR-0033.
    opts.set_capability("mfarm:name", test_name)
    # A third session waits for capacity instead of failing. Four devices, so this matters the
    # moment anyone runs pytest -n.
    opts.set_capability("mfarm:queueTimeoutSeconds", 180)
    return opts


@pytest.fixture
def driver(request):
    """A device per test, named after the test, released on every path including a crash."""
    d = webdriver.Remote(
        command_executor=_AuthConnection(HUB),
        options=_options(request.node.name),
    )
    failed = False
    try:
        yield d
    except Exception:
        failed = True
        raise
    finally:
        # `report` is set by the hook below, which is the only thing that knows whether the
        # ASSERTIONS passed -- an exception escaping the fixture is not the same question.
        outcome = "failed" if (failed or getattr(request.node, "mfarm_failed", False)) else "passed"
        try:
            # This is `lambda-status` renamed, and that is the point: a teardown changes one string
            # instead of acquiring an HTTP client, a dependency and somewhere to put the key.
            d.execute_script(f"mfarm-status={outcome}")
        except Exception:
            pass
        d.quit()


@pytest.hookimpl(hookwrapper=True, tryfirst=True)
def pytest_runtest_makereport(item, call):
    """Remember whether the test body failed, so the fixture can report the truth."""
    report = (yield).get_result()
    if report.when == "call" and report.failed:
        item.mfarm_failed = True
