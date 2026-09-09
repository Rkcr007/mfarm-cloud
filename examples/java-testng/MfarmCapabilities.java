package com.mfarm.example;

import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.options.UiAutomator2Options;
import org.openqa.selenium.remote.RemoteWebDriver;

import java.net.URI;
import java.net.URL;
import java.util.Map;

/**
 * Point a Java/TestNG/Cucumber Appium suite at MFARM.
 *
 * THIS FILE IS THE WHOLE ADOPTION CLAIM for a Java suite, the way `farm.js` is for a JavaScript
 * one. Everything else in such a suite — the page objects, the step definitions, the TestNG XML —
 * runs unchanged. What changes is a hub URL, a credential and four capabilities.
 *
 * It is written against the shape a suite arriving from LambdaTest actually has: a
 * `CreateMobileDriver` that builds capabilities and a `TestHooks` that opens a session per Cucumber
 * scenario and reports `lambda-status` in its teardown. The mapping is one-for-one, and the point of
 * the table below is that there is no fifth thing to work out.
 *
 *   lt:options.build        →  mfarm:runId + mfarm:runName   (see the note on why it is TWO)
 *   lt:options.name         →  mfarm:name
 *   app = "lt://APP…"       →  mfarm:appId  ("com.example.app@1.4.2", or "@latest", or a uuid)
 *   deviceName / platformVersion regex
 *                           →  mfarm:deviceClass  (a class, not a marketing name — see below)
 *   idleTimeout             →  mfarm:ttlMinutes
 *   (queue is implicit)     →  mfarm:queueTimeoutSeconds
 *   executeScript("lambda-status=" + s)
 *                           →  executeScript("mfarm-status=" + s)
 *
 * NOT A LIBRARY, and deliberately not. It is a file to copy into a suite and edit, because the one
 * thing a customer must be able to do is read every line that touches their driver. A dependency
 * here would be a jar to publish, version and trust for about sixty lines of `Map.of`.
 */
public final class MfarmCapabilities {

  /**
   * The hub. Nothing else about the URL matters — no `mobile-hub` versus `hub` split, no separate
   * REST host. The same origin serves the console, the WebDriver hub and the API.
   */
  private static final String HUB = System.getenv().getOrDefault("MFARM_HUB", "https://farm.mfarm.dev");

  /**
   * The credential, AS THE BASIC USERNAME with an empty password half.
   *
   * From the environment, never from a committed properties file. That is the one habit worth
   * changing on the way in: a key in `config.properties` is a key in the git history, and the
   * masking step a CI job runs to keep it out of logs is a mitigation for a problem that need not
   * exist. `https://<key>@farm.mfarm.dev/wd/hub` produces exactly this and is equivalent.
   */
  private static final String KEY = System.getenv("MFARM_API_KEY");

  private MfarmCapabilities() { }

  public static URL hub() throws Exception {
    if (KEY == null || KEY.isBlank()) {
      throw new IllegalStateException(
          "MFARM_API_KEY is not set. Mint one in the console under Settings -> API keys.");
    }
    // The key in the userinfo half. Appium's Java client turns this into the Authorization header;
    // building the header by hand is not necessary here the way it is in WebdriverIO.
    URI u = URI.create(HUB);
    return URI.create(u.getScheme() + "://" + KEY + "@" + u.getAuthority() + "/wd/hub").toURL();
  }

  /**
   * Capabilities for one scenario.
   *
   * @param scenarioName the Cucumber scenario, or the TestNG method — whatever your report calls
   *                     this test. It becomes the session's name in the console IMMEDIATELY, which
   *                     is what makes a run readable while it is still running rather than after.
   * @param runId        the id CI already has: $GITHUB_RUN_ID, a Jenkins BUILD_NUMBER. This is the
   *                     JOIN KEY back to the CI job, so it should be the machine's id, not a
   *                     sentence.
   * @param runName      what a person calls the run — the suite XML plus a timestamp, which is what
   *                     LambdaTest's `build` was. It is separate from `runId` because both are
   *                     wanted at once: the id is what clicks through to the CI job, and the name is
   *                     what somebody scans a list for. The FIRST session of a run sets it.
   */
  public static UiAutomator2Options forScenario(String scenarioName, String runId, String runName) {
    UiAutomator2Options options = new UiAutomator2Options();
    options.setPlatformName("Android");
    options.setAutomationName("UiAutomator2");

    /*
     * THE FARM CHOOSES THE DEVICE; YOU CHOOSE THE KIND.
     *
     * There is no `deviceName` regex here and no `platformVersion` list, and that is not a missing
     * feature — it is the allocator's contract. A suite that names a device is a suite that can be
     * handed one another tenant is using, so the request names a CLASS and the farm returns a
     * concrete device from it. Omit `mfarm:deviceClass` entirely to take any device that can run
     * WebDriver, which is the right default on a small fleet.
     *
     * The value is a profile id from the console's Fleet page (`mfarm-x1-pro`), NOT a marketing
     * name. Ask for a class this farm has none of and the session fails saying so, rather than
     * running your suite on the wrong screen geometry.
     */
    String deviceClass = System.getenv("MFARM_DEVICE_CLASS");
    if (deviceClass != null && !deviceClass.isBlank()) {
      options.setCapability("mfarm:deviceClass", deviceClass);
    }

    options.setCapability("mfarm:region", System.getenv().getOrDefault("MFARM_REGION", "lab"));

    /*
     * The build, from the farm's app library rather than a path on whichever host you landed on.
     *
     * This replaces `lt://APP…` and takes the same three forms a package manager does: a uuid,
     * `com.example.app` for the newest, or `com.example.app@1.4.2` to pin. The farm installs it
     * BEFORE the session opens, so the app is on screen when your first step runs.
     *
     * Do NOT also set `appium:app` — the two name the same thing and the hub refuses the pair
     * rather than guessing which one you meant.
     */
    String appId = System.getenv("MFARM_APP_ID");
    if (appId != null && !appId.isBlank()) options.setCapability("mfarm:appId", appId);

    /*
     * THE TWO LABELS. Without these a run is a list of uuids, which is the state every farm's
     * dashboard is in before somebody sets them.
     */
    options.setCapability("mfarm:name", scenarioName);
    if (runId != null && !runId.isBlank()) {
      options.setCapability("mfarm:runId", runId);
      if (runName != null && !runName.isBlank()) options.setCapability("mfarm:runName", runName);
    }

    /*
     * WAIT FOR CAPACITY INSTEAD OF FAILING, which is what a two-lane suite on a small farm needs.
     *
     * With this at 0 (the default) a `createSession` that finds no free device fails immediately,
     * and your client's retry loop becomes the queue — badly, because it loses its place every
     * time. With it set, the farm queues the request and tells the session where it stands.
     *
     * Ten minutes matches the 600s this kind of suite usually already sets as an idle timeout.
     */
    options.setCapability("mfarm:queueTimeoutSeconds", 600);

    return options;
  }

  /**
   * Tell the farm how the test went — the `@After` hook, and the reason this file is short.
   *
   * THIS IS THE `lambda-status` LINE, RENAMED. It goes through the driver the teardown already
   * holds, so there is no HTTP client to configure, no second credential to put somewhere and no
   * session id to correlate. A suite porting its teardown changes one string.
   *
   * MUST RUN BEFORE `quit()`. After the session ends there is no driver to send it through — the
   * same rule LambdaTest has, and the same failure if you break it: a run that shows as ended with
   * no verdict rather than as passed or failed.
   *
   * WHAT IT DOES NOT CARRY is the stack trace, because an `executeScript` payload has nowhere to put
   * one. For a failing test that is worth having, so post the full result instead — same fields,
   * from the same teardown:
   *
   *   POST {HUB}/v1/sessions/{driver.getSessionId()}/result
   *   Authorization: Bearer {MFARM_API_KEY}
   *   {"name": "...", "status": "failed", "failure": "<stack>", "durationMs": 1200}
   *
   * `driver.getSessionId()` is the FARM'S session id — the hub hands back its own rather than
   * Appium's — so one id spans your test log, the console, the artifacts and the invoice.
   */
  public static void reportStatus(RemoteWebDriver driver, boolean passed) {
    driver.executeScript("mfarm-status=" + (passed ? "passed" : "failed"));
  }

  /** Rename the session, for a suite that learns what the test is called after it starts. */
  public static void reportName(RemoteWebDriver driver, String name) {
    driver.executeScript("mfarm-name=" + name);
  }

  // ------------------------------------------------------------------ a whole TestHooks, for reference
  //
  // @Before
  // public void setUp(Scenario scenario) throws Exception {
  //     driver = new AndroidDriver(
  //         MfarmCapabilities.hub(),
  //         MfarmCapabilities.forScenario(
  //             scenario.getName(),
  //             System.getenv("GITHUB_RUN_ID"),
  //             xmlPath));                 // Android_UAE_Expenses_08_09_2026_06_53_38
  // }
  //
  // @After
  // public void tearDown(Scenario scenario) {
  //     if (driver == null) return;
  //     try {
  //         MfarmCapabilities.reportStatus(driver, !scenario.isFailed());
  //     } finally {
  //         driver.quit();                 // ALWAYS. A suite that forgets holds the device to TTL.
  //     }
  // }
}
