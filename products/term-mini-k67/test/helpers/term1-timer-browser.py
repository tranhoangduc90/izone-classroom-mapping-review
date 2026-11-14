import ipaddress
import sys
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


origin, student_ref, deadline = sys.argv[1:]
assert ipaddress.ip_address(urlparse(origin).hostname).is_loopback
with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors, media = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: media.append(request.url) if request.resource_type == "media" else None)
    page.route("**/*", lambda route: route.continue_() if route.request.url.startswith(origin + "/") else route.abort())
    page.add_init_script("localStorage.setItem('izone-term1-timer-device', 'b'.repeat(64));")
    page.goto(origin + "/term-tests/term-test-1-computer-based/listening-timer.html?class=IC2304")
    page.locator("#bootstrapStudent option").nth(2).wait_for(state="attached", timeout=8000)
    page.locator("#bootstrapStudent").select_option(student_ref)
    with page.expect_response(lambda response: response.url.endswith("/listening-timer/prepare"), timeout=5000) as prepared:
        page.get_by_role("button", name="Xác nhận, tiếp tục").click(timeout=5000)
    assert prepared.value.ok, prepared.value.text()
    with page.expect_response(lambda response: response.url.endswith("/listening-timer/start")) as started:
        page.locator("#bootstrapStart").click(timeout=5000)
    assert started.value.json()["listeningDeadlineAt"] == deadline
    try:
        page.get_by_role("timer", name="Thời gian Listening còn lại").wait_for(timeout=6000)
    except Exception as error:
        raise AssertionError((errors, page.locator("body").inner_text()[:500])) from error
    page.locator("#listeningView [data-number='1']").wait_for(timeout=6000)
    expected = {str(number): "A" for number in range(1, 31)}
    with page.expect_response(lambda response: response.url.endswith("/listening-timer/draft")
                              and response.request.post_data_json["answers"] == expected, timeout=8000) as saved:
        for number in range(1, 31):
            field = page.locator(f"#listeningView [data-number='{number}']").first
            if field.evaluate("field => field.tagName") == "SELECT":
                field.select_option("A")
            else:
                field.fill("A")
    assert saved.value.json()["accepted"]
    assert not media, media
    assert not errors, errors
    page.close(run_before_unload=False)
    assert page.is_closed()
    print("Chromium: selected and confirmed identity, verified shared deadline, received draft for 30 answers, closed the tab, no media request")
