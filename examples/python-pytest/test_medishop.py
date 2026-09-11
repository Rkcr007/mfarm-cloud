"""
MediShop's sign-in flow, in Python.

DELIBERATELY THE SAME THREE ASSERTIONS as `examples/medishop-suite/specs/login.spec.js`, so that the
only difference between the two runs is the language. If both produce the same rows on the same Runs
screen, "any language" is a measured fact rather than a claim about protocols.

SELECTORS ARE TEXT AND ACCESSIBILITY ID, NEVER RESOURCE-ID. MediShop is Jetpack Compose and Compose
emits no resource-ids at all -- the usual advice "always select by id" is not available, and a suite
that waits for one waits forever. `pages/base.js` in the WebdriverIO suite says the same thing; it is
a property of the app, not of the client.
"""
import pytest
from appium.webdriver.common.appiumby import AppiumBy
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

from conftest import CREDENTIALS


def by_text(text):
    # XPath 1.0 has no escape for a quote inside a literal. None of the copy here contains one, and
    # a helper that pretends otherwise without `concat()` would be a lie waiting to be found.
    assert "'" not in text, "use concat() for copy containing an apostrophe"
    return (AppiumBy.XPATH, f"//*[@text='{text}']")


def showing(driver, text, timeout=8):
    try:
        WebDriverWait(driver, timeout).until(EC.presence_of_element_located(by_text(text)))
        return True
    except TimeoutException:
        return False


def wait_for_sign_in(driver):
    # The app shows a splash ("INITIALIZING SYSTEM") before the form, so the first thing to wait for
    # is the FORM, not the app. 40s because a cold Compose start on a freshly powerwashed device is
    # genuinely slow, and a tighter wait makes a working farm look broken.
    WebDriverWait(driver, 40).until(EC.presence_of_element_located(by_text("Welcome Back")))


def sign_in(driver, email, password):
    fields = driver.find_elements(AppiumBy.CLASS_NAME, "android.widget.EditText")
    assert len(fields) >= 2, f"expected the two sign-in fields, found {len(fields)}"
    fields[0].clear()
    fields[0].send_keys(email)
    fields[1].clear()
    fields[1].send_keys(password)
    driver.find_element(*by_text("Sign In")).click()


def test_the_app_opens_on_the_practice_portal(driver):
    wait_for_sign_in(driver)
    assert showing(driver, "Sign in to the Practice Portal")


def test_the_wrong_password_does_not_sign_anyone_in(driver):
    wait_for_sign_in(driver)
    sign_in(driver, CREDENTIALS["email"], "definitely-not-the-password")
    assert showing(driver, "Welcome Back"), "a bad password must leave you on the sign-in screen"
    assert not showing(driver, "Good Morning,", timeout=3), "a bad password must not reach the home screen"


def test_the_real_credentials_reach_the_home_screen(driver):
    wait_for_sign_in(driver)
    sign_in(driver, CREDENTIALS["email"], CREDENTIALS["password"])
    assert showing(driver, "Good Morning,", timeout=30), "the real credentials should reach the home screen"
