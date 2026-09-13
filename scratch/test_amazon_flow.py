import os
import sys
import time

sys.path.insert(0, os.path.abspath('.'))
sys.path.insert(0, os.path.abspath('server'))

from fastapi.testclient import TestClient
from server.main import app

# DOM for each stage of Amazon checkout funnel
stages = [
    {
        "name": "Stage 1: Search Results",
        "dom": """Page: Amazon.in : Samsung S26 Ultra 256 GB (www.amazon.in)
Viewport: 1536x730
Scroll: 0/4500
Elements: 45
---
[0] <input> id="twotabsearchtextbox" name="field-keywords" value="Samsung S26 Ultra 256 GB" sel="#twotabsearchtextbox" @(344,11,614x38)
[1] <input> (button) id="nav-search-submit-button" value="Go" sel="#nav-search-submit-button" @(958,11,45x38)
[2] <a> (link) "Galaxy S26 5G (Black, 12GB RAM, 256GB Storage), AI Phone" href="/dp/B0D12345" sel="div.s-result-item:nth-of-type(1) h2 a" @(512,180,480x44)
[3] <button> (button) "Add to cart" id="a-autoid-1-announce" sel="button#a-autoid-1-announce" @(512,398,244x30)
[4] <a> (link) "Samsung Galaxy S24 Ultra 5G AI Smartphone" href="/dp/B0CX54321" sel="div.s-result-item:nth-of-type(2) h2 a" @(512,600,480x44)
""",
        "expected_action": "cart or product"
    },
    {
        "name": "Stage 2: Added to Cart Confirmation Drawer",
        "dom": """Page: Amazon.in Shopping Cart (www.amazon.in)
Viewport: 1536x730
Scroll: 0/1000
Elements: 20
---
[0] <span> "Added to cart" sel="div.attach-accessory-section span" @(1000,50,200x30)
[1] <input> (button) "Proceed to checkout (1 item)" name="proceedToRetailCheckout" sel="input[name='proceedToRetailCheckout']" @(1000,120,280x35)
[2] <a> (link) "Go to Cart" id="attach-sidesheet-view-cart-button" sel="#attach-sidesheet-view-cart-button" @(1000,170,280x30)
""",
        "expected_action": "proceed"
    },
    {
        "name": "Stage 3: Delivery Address Selection",
        "dom": """Page: Select a delivery address - Amazon.in Checkout (www.amazon.in)
Viewport: 1536x730
Scroll: 0/1200
Elements: 25
---
[0] <h2> "Select a delivery address" sel="h2.address-page-heading" @(200,50,400x30)
[1] <span> "Home: 123 Tech Park, Bangalore 560001" sel="div.address-card span" @(200,100,300x50)
[2] <input> (button) "Deliver to this address" name="submissionURL" sel="input#shipToThisAddressButton" @(200,180,240x35)
""",
        "expected_action": "address"
    },
    {
        "name": "Stage 4: Payment Method Selection",
        "dom": """Page: Select a Payment Method - Amazon.in Checkout (www.amazon.in)
Viewport: 1536x730
Scroll: 0/1400
Elements: 30
---
[0] <h2> "Select a payment method" sel="h2.payment-page-heading" @(200,50,400x30)
[1] <input> (radio) "Amazon Pay UPI / Net Banking" sel="input[value='SelectPaymentPlanEvent:UPI']" @(200,120,20x20)
[2] <input> (button) "Use this payment method" name="ppw-widgetEvent:SetPaymentPlanSelectContinueEvent" sel="input[name='ppw-widgetEvent:SetPaymentPlanSelectContinueEvent']" @(200,220,260x35)
""",
        "expected_action": "payment"
    },
    {
        "name": "Stage 5: Final Review & Place Order",
        "dom": """Page: Place Your Order - Amazon.in Checkout (www.amazon.in)
Viewport: 1536x730
Scroll: 0/1800
Elements: 35
---
[0] <h2> "Review your order" sel="h2.order-review-heading" @(200,50,400x30)
[1] <span> "Order Total: ₹79,999.00" sel="div.order-summary-box span" @(800,80,200x30)
[2] <input> (button) "Place your order and pay" name="placeYourOrder1" sel="input[name='placeYourOrder1']" @(800,140,280x40)
""",
        "expected_action": "goal complete"
    }
]

history = [
    "[✓ SUCCESS] Navigated to https://amazon.in",
    "[✓ SUCCESS] Typed \"Samsung S26 Ultra 256 GB\" into #twotabsearchtextbox",
    "[✓ SUCCESS] Clicked #nav-search-submit-button"
]

print("=================================================================", flush=True)
print("TESTING FULL E-COMMERCE CHECKOUT PIPELINE SIMULATION", flush=True)
print("=================================================================", flush=True)

all_passed = True

with TestClient(app) as client:
    for i, stage in enumerate(stages, 1):
        print(f"\n--- {stage['name']} ---", flush=True)
        payload = {
            "image": None,
            "dom_summary": stage["dom"],
            "redaction_manifest": {"redactions": []},
            "user_goal": "buy samsung s26 ultra 256 gb via amazon.in complete check out",
            "action_history": history
        }
        res = client.post("/api/analyze", json=payload)
        data = res.json()
        print(f"Status: {res.status_code} ({data.get('latency_ms')}ms)", flush=True)
        print("Reasoning:", data.get("reasoning"), flush=True)
        print("Actions:", data.get("actions"), flush=True)
        print("Is Goal Complete:", data.get("is_goal_complete"), flush=True)

        actions = data.get("actions") or []
        is_complete = data.get("is_goal_complete", False)

        if stage["expected_action"] == "goal complete":
            if is_complete and not actions:
                print(">>> PASSED: Successfully reached goal completion!", flush=True)
            else:
                print(">>> FAILED: Expected goal complete!", flush=True)
                all_passed = False
        else:
            if actions:
                act = actions[0]
                print(f">>> PASSED: Action generated: {act.get('type')} on {act.get('selector')}", flush=True)
                history.append(f"[✓ SUCCESS] {act.get('type')} on {act.get('selector')}")
            else:
                print(">>> FAILED: No action generated!", flush=True)
                all_passed = False

print("\n=================================================================", flush=True)
if all_passed:
    print("ALL 5 STAGES OF THE E-COMMERCE CHECKOUT FLOW COMPLETED SUCCESSFULLY!", flush=True)
else:
    print("SOME STAGES FAILED OR HESITATED!", flush=True)
print("=================================================================", flush=True)
