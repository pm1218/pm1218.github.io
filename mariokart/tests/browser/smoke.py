"""Mobile browser smoke test of the whole UI against an in-memory Supabase mock.

Run from the mariokart/ folder:
    python3 -m http.server 8765 &      # serve the static app
    python3 tests/browser/smoke.py     # needs: pip install playwright && playwright install chromium

Screenshots land in tests/browser/screens/.
"""
import os, pathlib, re, sys
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("APP_URL", "http://localhost:8765/")
HERE = pathlib.Path(__file__).parent
SHOTS = HERE / "screens"
SHOTS.mkdir(exist_ok=True)
MOCK = (HERE / "mock-supabase.js").read_text()
CONFIG = "export const CONFIG = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_ANON_KEY: 'mock', APP_NAME: 'Kart Club' };"
errors = []


def shot(page, name):
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)
    overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    assert overflow <= 0, f"{name}: page scrolls sideways by {overflow}px"
    text = page.inner_text("main")
    assert not re.search(r"\b(null|undefined|NaN)\b", text), f"{name}: stray null/undefined/NaN rendered"


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("dialog", lambda d: d.accept())
        page.route(re.compile(r".*supabase-js@2/\+esm$"), lambda r: r.fulfill(body=MOCK, content_type="text/javascript"))
        page.route(re.compile(r".*/js/config\.js$"), lambda r: r.fulfill(body=CONFIG, content_type="text/javascript"))

        # --- login with an emailed one-time code
        page.goto(BASE)
        expect(page.get_by_label("Email")).to_be_visible()
        shot(page, "01-login")
        page.get_by_label("Email").fill("admin@example.com")
        page.get_by_role("button", name="Email me a code").click()
        page.get_by_label("6-digit code").fill("000000")
        expect(page.get_by_text("Token has expired or is invalid")).to_be_visible()
        page.get_by_label("6-digit code").fill("123456")
        expect(page.get_by_role("heading", name="Events")).to_be_visible()
        shot(page, "02-events-empty")

        # --- create an event
        page.get_by_text("+ New event").click()
        page.get_by_label("Name").fill("Lake house weekend")
        page.get_by_label("Type").select_option("trip")
        page.get_by_role("button", name="Create event").click()
        expect(page.get_by_role("heading", name="Lake house weekend")).to_be_visible()

        # --- GP 1: race by race, the 4-race rule
        page.get_by_role("button", name="+ Add Grand Prix").click()
        expect(page.get_by_role("heading", name=re.compile("GP 1"))).to_be_visible()
        page.get_by_role("tab", name="All 4 races").click()
        page.get_by_role("button", name="Add everyone").click()
        page.get_by_role("button", name="+ CPU").click()
        orders = [[1, 2, 4, 3], [3, 1, 2, 4], [1, 3, 2, 4], [2, 1, 4, 3]]
        names = ["Prateek", "Anya", "Dev", "CPU"]
        for ri, order in enumerate(orders[:3]):
            page.get_by_role("tab", name=re.compile(rf"^R{ri + 1}")).click()
            for name, place in zip(names, order):
                page.get_by_label(f"{name} placement in race {ri + 1}").select_option(str(place))
        expect(page.get_by_text("3 of 4 races complete")).to_be_visible()
        expect(page.get_by_role("button", name="Confirm & email everyone")).to_be_disabled()
        shot(page, "03-races-incomplete")
        page.get_by_role("tab", name=re.compile(r"^R4")).click()
        for name, place in zip(names, orders[3]):
            page.get_by_label(f"{name} placement in race 4").select_option(str(place))
        expect(page.get_by_text("All 4 races complete")).to_be_visible()
        confirm = page.get_by_role("button", name="Confirm & email everyone")
        expect(confirm).to_be_enabled()
        shot(page, "04-races-complete")
        confirm.click()
        expect(page.get_by_role("heading", name="Race by race")).to_be_visible()
        # Prateek 15+10+15+12 and Anya 12+15+10+15 tie on 52 -> both shown 1st
        rows = page.locator(".results tbody tr")
        expect(rows.nth(0)).to_contain_text("🥇")
        expect(rows.nth(1)).to_contain_text("🥇")
        expect(rows.nth(1)).to_contain_text("52")
        expect(rows.nth(2)).to_contain_text("🥉")
        assert page.evaluate("window.__mails.length") == 1, "summary email not sent"
        shot(page, "05-gp-confirmed")

        # --- GP 2: final totals only
        page.get_by_role("link", name=re.compile("Lake house weekend")).click()
        page.get_by_role("button", name="+ Add Grand Prix").click()
        page.get_by_role("tab", name="Final totals").click()
        page.get_by_role("button", name="Add everyone").click()
        for name, total in [("Prateek", "41"), ("Anya", "50"), ("Dev", "61")]:
            page.get_by_label(f"{name} total").fill(total)
        expect(page.get_by_text("Dev needs a total from 0 to 60.")).to_be_visible()
        page.get_by_label("Dev total").fill("47")
        page.get_by_role("button", name="Confirm & email everyone").click()
        expect(page.locator(".results tbody tr").first).to_contain_text("Anya")

        # --- photo tab: race mode needs all four photos
        page.get_by_role("link", name=re.compile("Lake house weekend")).click()
        expect(page.get_by_role("heading", name="Event power rankings")).to_be_visible()
        shot(page, "06-event")
        page.get_by_role("button", name="+ Add Grand Prix").click()
        page.get_by_role("tab", name="📷 Photo").click()
        page.get_by_role("radio", name="4 race screens").click()
        expect(page.get_by_text("0 of 4 race photos added")).to_be_visible()
        expect(page.get_by_role("button", name="Analyze photos")).to_be_disabled()
        page.locator("#ph-0").set_input_files(str(HERE.parent / "fixtures" / "race_photo.jpg"))
        expect(page.get_by_text("1 of 4 race photos added")).to_be_visible()
        expect(page.get_by_role("button", name="Analyze photos")).to_be_disabled()
        shot(page, "07-photo-needs-four")
        page.get_by_role("button", name=re.compile("Use that instead")).click()
        expect(page.get_by_role("button", name="Analyze photo", exact=True)).to_be_disabled()

        # --- stats
        page.get_by_role("link", name="Stats").click()
        expect(page.get_by_role("heading", name="Power rankings")).to_be_visible()
        expect(page.get_by_role("heading", name="Head to head")).to_be_visible()
        expect(page.locator(".h2h-score strong")).to_have_text(re.compile(r"\d+ – \d+"))
        shot(page, "08-stats")

        # --- profile + admin
        page.get_by_role("link", name="Me").click()
        page.get_by_label("Favourite character").select_option("Rosalina")
        page.get_by_role("button", name="Save").click()
        expect(page.get_by_text("Saved")).to_be_visible()
        page.get_by_role("link", name="Admin").click()
        page.get_by_label("Add a member").fill("sam@example.com")
        page.get_by_role("button", name="Approve email").click()
        expect(page.get_by_text("sam@example.com", exact=True)).to_be_visible()
        shot(page, "09-admin")

        # --- desktop width still fine
        page.set_viewport_size({"width": 1280, "height": 900})
        page.get_by_role("link", name="Stats").click()
        expect(page.get_by_role("heading", name="Power rankings")).to_be_visible()
        shot(page, "10-stats-desktop")
        browser.close()


run()
real = [e for e in errors if "Failed to load resource" not in e and "Token has expired" not in e]  # wrong code is entered on purpose
if real:
    print("JS errors:", *real, sep="\n  ")
    sys.exit(1)
print("smoke test passed")
