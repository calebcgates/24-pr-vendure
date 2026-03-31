import { type Page, expect, test } from '@playwright/test';

import { BaseListPage } from '../../page-objects/list-page.base.js';
import { VendureAdminClient } from '../../utils/vendure-admin-client.js';

// Orders use a multi-step draft flow rather than a single CRUD form.
// Each action (set customer, add line, set address, set shipping) is an
// individual mutation — there's no "Create" button. The "Complete draft"
// button finalizes the order once all requirements are met.

test.describe('Orders', () => {
    test.describe.configure({ mode: 'serial' });

    const listPage = (page: Page) =>
        new BaseListPage(page, {
            path: '/orders',
            title: 'Orders',
            newButtonLabel: 'Draft order',
            newButtonRole: 'button',
        });

    test('should display the orders list page', async ({ page }) => {
        const lp = listPage(page);
        await lp.goto();
        await lp.expectLoaded();
    });

    test('should show "Draft order" button', async ({ page }) => {
        const lp = listPage(page);
        await lp.goto();
        await lp.expectLoaded();
        await expect(lp.newButton).toBeVisible();
    });

    test('should create, configure, and complete a draft order', async ({ page }) => {
        test.setTimeout(60_000); // Draft order flow involves multiple mutations

        // Step 1: Create a draft order from the list page
        const lp = listPage(page);
        await lp.goto();
        await lp.expectLoaded();
        await lp.newButton.click();
        await expect(page).toHaveURL(/\/orders\/draft\//, { timeout: 10_000 });

        // Step 2: Set a customer — CustomerSelector uses Command/Popover
        await page.getByRole('button', { name: /Select customer/i }).click();
        await page.getByPlaceholder('Search customers...').fill('hayden');
        // CommandItems have role="option"; wait for search results to load
        await expect(page.getByRole('option').first()).toBeVisible({ timeout: 5_000 });
        await page.getByRole('option').first().click();
        // Wait for the set-customer mutation to complete and re-render
        await page.waitForResponse(resp => resp.url().includes('/admin-api') && resp.status() === 200);

        // Step 3: Add a product variant — ProductVariantSelector uses Command/Popover
        // The button has role="combobox" but no aria-label, so we match by role + text content
        const addItemButton = page.locator('[role="combobox"]').filter({ hasText: 'Add item to order' });
        await addItemButton.scrollIntoViewIfNeeded();
        await addItemButton.click();
        await page.getByPlaceholder('Add item to order...').fill('laptop');
        await expect(page.getByRole('option').first()).toBeVisible({ timeout: 5_000 });
        await page.getByRole('option').first().click();
        // Wait for add-line mutation — the combobox should close
        await page.waitForResponse(resp => resp.url().includes('/admin-api') && resp.status() === 200);

        // Step 4: Set shipping address — CustomerAddressSelector uses Popover with Card elements
        // There are two "Select address" buttons (shipping + billing); target the first one
        await page
            .getByRole('button', { name: /Select address/i })
            .first()
            .click();
        // Address cards are plain divs in the popover — click the first one
        await page.locator('[data-slot="popover-content"]').locator('[data-slot="card"]').first().click();
        // Wait for set-address mutation
        await page.waitForResponse(resp => resp.url().includes('/admin-api') && resp.status() === 200);

        // Step 5: Select a shipping method — inline cards (not a popover)
        // Shipping methods appear after address is set; wait for them
        // Use exact text match to avoid ambiguity with the outer wrapper card
        const shippingLabel = page.getByText('Standard Shipping', { exact: true });
        await shippingLabel.scrollIntoViewIfNeeded();
        await expect(shippingLabel).toBeVisible({ timeout: 5_000 });
        await shippingLabel.click();
        // Wait for set-shipping-method mutation
        await page.waitForResponse(resp => resp.url().includes('/admin-api') && resp.status() === 200);

        // Step 6: Complete the draft order
        const completeDraftButton = page.getByRole('button', { name: /Complete draft/i });
        await completeDraftButton.scrollIntoViewIfNeeded();
        await expect(completeDraftButton).toBeEnabled({ timeout: 5_000 });
        await completeDraftButton.click();
        // After completion, navigates to the regular order detail page
        await expect(page).toHaveURL(/\/orders\/[^/]+$/, { timeout: 10_000 });
        await expect(page).not.toHaveURL(/\/draft\//);
    });

    test('should show the completed order in the list', async ({ page }) => {
        const lp = listPage(page);
        await lp.goto();
        await lp.expectLoaded();
        await lp.expectRowCountGreaterThan(0);
    });

    test('should create and delete a draft order', async ({ page }) => {
        // Create a new draft
        const lp = listPage(page);
        await lp.goto();
        await lp.expectLoaded();
        await lp.newButton.click();
        await expect(page).toHaveURL(/\/orders\/draft\//, { timeout: 10_000 });

        // Delete the draft without configuring it
        await page.getByRole('button', { name: /Delete draft/i }).click();
        // Confirm the deletion dialog — AlertDialog uses "Continue" as the action button
        await page.locator('[role="alertdialog"]').getByRole('button', { name: 'Continue' }).click();
        // Should navigate back to the orders list (URL may include query params)
        await expect(page).not.toHaveURL(/\/draft\//, { timeout: 15_000 });
        await expect(page.getByTestId('page-heading')).toBeVisible();
    });

    // #4393 — custom order history entry types should be displayed with key-value data
    test('should display custom order history entry types', async ({ page }) => {
        test.setTimeout(60_000);

        const client = new VendureAdminClient(page);
        await client.login();
        const orderId = await createPaidOrder(client);

        await client.gql(
            `mutation ($orderId: ID!, $message: String!) {
                addCustomOrderHistoryEntry(orderId: $orderId, message: $message) { id }
            }`,
            { orderId, message: 'Hello from a custom plugin' },
        );

        await page.goto(`/orders/${orderId}`);
        // Wait for the order detail page to load
        await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({ timeout: 10_000 });

        // Scroll down to the Order history section (CardTitle is a div, not a heading)
        const historyTitle = page.locator('[data-slot="card-title"]').filter({ hasText: 'Order history' });
        await historyTitle.scrollIntoViewIfNeeded();
        await expect(historyTitle).toBeVisible();

        // The fallback renderer displays the entry type as a humanised title
        // and renders the data as key-value pairs
        await expect(page.getByText('custom type')).toBeVisible({ timeout: 5_000 });
        await expect(page.getByText('message:')).toBeVisible();
        await expect(page.getByText('Hello from a custom plugin')).toBeVisible();
    });

    // #4391 — clicking Edit on address during order modification should not hide the address
    test('should keep address visible when editing during order modification', async ({ page }) => {
        test.setTimeout(60_000);

        const orderId = await createModifyingOrder(page);

        await page.goto(`/orders/${orderId}/modify`);
        await expect(page.getByRole('heading', { name: 'Modify order' })).toBeVisible({ timeout: 10_000 });

        // Verify the shipping address is displayed
        await expect(page.getByText('123 Main St')).toBeVisible();
        await expect(page.getByText('London')).toBeVisible();

        // Click the Edit button for the shipping address
        const editButtons = page.getByRole('button', { name: 'Edit' });
        await editButtons.first().click();

        // The address should still be visible after clicking Edit
        await expect(page.getByText('123 Main St')).toBeVisible();
        await expect(page.getByText('London')).toBeVisible();

        // The address selector popover should auto-open
        await expect(page.locator('[data-slot="popover-content"]')).toBeVisible({ timeout: 5_000 });
        await expect(page.getByText('Select an address')).toBeVisible();
    });

    // #4393 — order modify page should show a "Recalculate shipping" checkbox
    test('should show recalculate shipping checkbox on modify page', async ({ page }) => {
        test.setTimeout(60_000);

        const orderId = await createModifyingOrder(page);

        await page.goto(`/orders/${orderId}/modify`);
        await expect(page.getByRole('heading', { name: 'Modify order' })).toBeVisible({ timeout: 10_000 });

        // Checkbox should be visible but disabled when no modifications made.
        // Base UI Checkbox separates the visual span[role="checkbox"] from the hidden
        // input[id], so getByRole('checkbox', { name }) can't resolve the label association.
        // Use the label text to find the containing element, then locate the checkbox within.
        const recalculateCheckbox = page.getByTestId('recalculate-shipping-field').getByRole('checkbox');
        await expect(recalculateCheckbox).toBeVisible({ timeout: 10_000 });
        await expect(recalculateCheckbox).toBeChecked();
        await expect(recalculateCheckbox).toBeDisabled();

        // Make a modification (change quantity) to enable the checkbox
        const quantityInput = page.getByTestId('order-line-quantity').first();
        await quantityInput.fill('2');

        await expect(recalculateCheckbox).toBeEnabled();
        await expect(recalculateCheckbox).toBeChecked();

        // Should be togglable
        await recalculateCheckbox.click();
        await expect(recalculateCheckbox).not.toBeChecked();
        await recalculateCheckbox.click();
        await expect(recalculateCheckbox).toBeChecked();
    });

    test.describe('Order lifecycle', () => {
        test('should fulfill an order', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            // Click "Fulfill order" to open the fulfill dialog
            await page.getByRole('button', { name: /Fulfill order/i }).click();

            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible();
            await expect(dialog.getByRole('heading', { name: 'Fulfill order' })).toBeVisible();

            // The dialog should show order line items with quantity inputs
            await expect(dialog.getByTestId('fulfill-quantity').first()).toBeVisible();

            // Submit the fulfillment
            await dialog.getByRole('button', { name: /Fulfill order/i }).click();

            // Wait for the mutation and verify success
            await expect(
                page.locator('[data-sonner-toast]').filter({ hasNotText: /error/i }).first(),
            ).toBeVisible({ timeout: 10_000 });
        });

        test('should transition order state', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createFulfilledOrder(client);

            await page.goto(`/orders/${orderId}`);

            // The state transition control is a badge with a dropdown trigger
            // Find the ellipsis button near the state badge
            const stateSection = page
                .locator('[data-slot="card"]')
                .filter({ hasText: /Fulfilled/i })
                .first();
            await expect(stateSection).toBeVisible({ timeout: 10_000 });

            // Click the ellipsis dropdown button next to the state badge
            const dropdownTrigger = stateSection.getByTestId('state-transition-trigger');
            await dropdownTrigger.click();

            // Select "Transition to Shipped" from the dropdown
            const menu = page.locator('[data-slot="dropdown-menu-content"]');
            await expect(menu).toBeVisible();
            await menu
                .getByText(/Shipped/i)
                .first()
                .click();

            // Wait for the mutation and page to update
            await page.waitForResponse(resp => resp.url().includes('/admin-api') && resp.status() === 200);

            // Reload to get a clean page state, then verify the order is now "Shipped"
            await page.reload();
            await expect(
                page
                    .locator('[data-slot="card"]')
                    .filter({ hasText: /Shipped/i })
                    .first(),
            ).toBeVisible({ timeout: 10_000 });
        });

        test('should open refund dialog and show order lines', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            // The "Refund & Cancel" option is in the page action bar dropdown
            // Open the more actions dropdown (ellipsis in the action bar)
            const actionBarEllipsis = page.getByTestId('action-bar-dropdown-trigger');
            await expect(actionBarEllipsis).toBeVisible({ timeout: 10_000 });
            await actionBarEllipsis.click();

            // Click "Refund & Cancel"
            const menu = page.locator('[data-slot="dropdown-menu-content"]');
            await expect(menu).toBeVisible();
            await menu
                .getByText(/Refund/i)
                .first()
                .click();

            // The refund dialog should open
            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible({ timeout: 5_000 });
            await expect(dialog.getByText(/Refund/i).first()).toBeVisible();

            // The dialog should show order line items
            await expect(dialog.getByTestId('refund-quantity').first()).toBeVisible();

            // The dialog should have a reason selector
            await expect(dialog.getByText('Reason', { exact: true })).toBeVisible();

            // Close without submitting
            await dialog.getByRole('button', { name: 'Cancel' }).click();
        });

        test('should process a refund', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            // Open the refund dialog via action bar dropdown
            const actionBarEllipsis = page.getByTestId('action-bar-dropdown-trigger');
            await expect(actionBarEllipsis).toBeVisible({ timeout: 10_000 });
            await actionBarEllipsis.click();

            const menu = page.locator('[data-slot="dropdown-menu-content"]');
            await menu
                .getByText(/Refund/i)
                .first()
                .click();

            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible({ timeout: 5_000 });

            // Set refund quantity to 1 for the first line item
            const quantityInput = dialog.getByTestId('refund-quantity').first();
            await quantityInput.fill('1');

            // Select a refund reason
            await dialog.getByRole('combobox').click();
            await page.getByRole('option').first().click();

            // Select the first available payment for refund
            const paymentCheckbox = dialog.getByRole('checkbox').first();
            if (await paymentCheckbox.isVisible()) {
                await paymentCheckbox.check();
            }

            // Submit the refund
            const refundButton = dialog.getByRole('button', { name: /Refund/i }).last();
            await refundButton.click();

            // Wait for success
            await expect(
                page.locator('[data-sonner-toast]').filter({ hasNotText: /error/i }).first(),
            ).toBeVisible({ timeout: 10_000 });
        });

        // #4563 — refund to custom destination (store credit)
        test('should process a refund to a custom destination', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            // Open the refund dialog
            const actionBarEllipsis = page.getByTestId('action-bar-dropdown-trigger');
            await expect(actionBarEllipsis).toBeVisible({ timeout: 10_000 });
            await actionBarEllipsis.click();

            const menu = page.locator('[data-slot="dropdown-menu-content"]');
            await menu
                .getByText(/Refund/i)
                .first()
                .click();

            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible({ timeout: 5_000 });

            // Set refund quantity to 1
            const quantityInput = dialog.getByTestId('refund-quantity').first();
            await quantityInput.fill('1');

            // Select a reason
            await dialog.getByRole('combobox').click();
            await page.getByRole('option').first().click();

            // Uncheck original payment, check store credit destination
            const checkboxes = dialog.getByRole('checkbox');
            // The "Refund to" section checkboxes: first is "Return to stock",
            // then the payment targets. Find the store credit target by label.
            const storeCreditTarget = dialog.getByText(/store credit/i).locator('..');
            const storeCreditCheckbox = storeCreditTarget.getByRole('checkbox');
            await expect(storeCreditCheckbox).toBeVisible();

            // Uncheck the original payment (method is "test-payment" from createPaidOrder)
            const paymentTarget = dialog.getByText(/test-payment/i).locator('..');
            const paymentCheckbox = paymentTarget.getByRole('checkbox');
            await paymentCheckbox.uncheck();

            // Check store credit and enter amount
            await storeCreditCheckbox.check();
            const storeCreditAmount = storeCreditTarget.locator('input[type="number"]');
            await storeCreditAmount.fill('1');

            // Submit
            const refundButton = dialog.getByRole('button', { name: /Refund/i }).last();
            await refundButton.click();

            // Wait for success
            await expect(
                page.locator('[data-sonner-toast]').filter({ hasNotText: /error/i }).first(),
            ).toBeVisible({ timeout: 10_000 });
        });

        // #4563 — refund dialog should show store credit destination
        test('should display custom refund destinations in dialog', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            await openRefundDialog(page);

            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible({ timeout: 5_000 });

            // The "Other refund destinations" section should be visible
            await expect(dialog.getByText('Other refund destinations')).toBeVisible();

            // Store credit destination should appear
            const storeCreditRow = dialog.getByTestId('refund-target-store-credit');
            await expect(storeCreditRow).toBeVisible();

            // Store credit should be unchecked by default
            await expect(storeCreditRow.getByRole('checkbox').first()).not.toBeChecked();
        });

        // #4563 — refund dialog should validate allocated amounts match total
        test('should show validation error when allocation does not match total', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            await openRefundDialog(page);

            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible({ timeout: 5_000 });

            // Set refund quantity to 1 — this auto-allocates to the first payment
            const quantityInput = dialog.getByTestId('refund-quantity').first();
            await quantityInput.fill('1');

            // Select a reason
            await dialog.getByRole('combobox').click();
            await page.getByRole('option').first().click();

            // Uncheck the original payment to create an allocation mismatch
            const paymentRow = dialog.getByTestId(/^refund-target-payment-/);
            await paymentRow.getByRole('checkbox').first().uncheck();

            // Validation error should appear about allocation mismatch
            await expect(dialog.getByText(/Allocated refund amounts must equal refund total/i)).toBeVisible();

            // Submit button should be disabled
            const refundButton = dialog.getByRole('button', { name: /Refund/i }).last();
            await expect(refundButton).toBeDisabled();
        });

        // #4563 — split refund between original payment and store credit
        test('should process a split refund across payment and destination', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            await openRefundDialog(page);

            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible({ timeout: 5_000 });

            // Set refund quantity to 1
            const quantityInput = dialog.getByTestId('refund-quantity').first();
            await quantityInput.fill('1');

            // Select a reason
            await dialog.getByRole('combobox').click();
            await page.getByRole('option').first().click();

            // Read the auto-calculated total from the payment row
            const paymentRow = dialog.getByTestId(/^refund-target-payment-/);
            const paymentAmountStr = await paymentRow.locator('input[type="number"]').inputValue();
            const fullAmount = Number.parseFloat(paymentAmountStr);

            // Split: half to original payment, half to store credit
            const halfAmount = (Math.floor((fullAmount * 100) / 2) / 100).toFixed(2);
            const remainingAmount = (fullAmount - Number.parseFloat(halfAmount)).toFixed(2);

            // Set the payment amount to half
            await paymentRow.locator('input[type="number"]').fill(halfAmount);

            // Enter remaining amount into store credit
            const storeCreditRow = dialog.getByTestId('refund-target-store-credit');
            await storeCreditRow.locator('input[type="number"]').fill(remainingAmount);

            // Submit the split refund
            const refundButton = dialog.getByRole('button', { name: /Refund/i }).last();
            await refundButton.click();

            // Wait for success
            await expect(
                page.locator('[data-sonner-toast]').filter({ hasNotText: /error/i }).first(),
            ).toBeVisible({ timeout: 10_000 });
        });

        // #4563 — refund with manual total override
        test('should allow manual refund total override', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            await openRefundDialog(page);

            const dialog = page.locator('[role="dialog"]');
            await expect(dialog).toBeVisible({ timeout: 5_000 });

            // Check the "Override" checkbox to enable manual total
            const overrideCheckbox = dialog.getByText('Override').locator('..').getByRole('checkbox');
            await overrideCheckbox.check();

            // Enter a manual refund total
            const totalInput = dialog.locator('input[type="number"]').first();
            await totalInput.fill('5.00');

            // Select a reason
            await dialog.getByRole('combobox').click();
            await page.getByRole('option').first().click();

            // Submit
            const refundButton = dialog.getByRole('button', { name: /Refund/i }).last();
            await refundButton.click();

            await expect(
                page.locator('[data-sonner-toast]').filter({ hasNotText: /error/i }).first(),
            ).toBeVisible({ timeout: 10_000 });
        });

        test('should show order history entries for lifecycle events', async ({ page }) => {
            test.setTimeout(60_000);

            const client = new VendureAdminClient(page);
            await client.login();
            const orderId = await createPaidOrder(client);

            await page.goto(`/orders/${orderId}`);
            await expect(page.getByRole('button', { name: /Fulfill order/i })).toBeVisible({
                timeout: 10_000,
            });

            // Scroll to the Order history section
            const historyTitle = page
                .locator('[data-slot="card-title"]')
                .filter({ hasText: 'Order history' });
            await historyTitle.scrollIntoViewIfNeeded();
            await expect(historyTitle).toBeVisible();

            // The history should contain payment-related entries
            await expect(page.getByText(/Payment/i).first()).toBeVisible();
        });
    });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a paid order and adds a fulfillment, returning the order ID
 * in "Fulfilled" state.
 */
async function createFulfilledOrder(client: VendureAdminClient): Promise<string> {
    const orderId = await createPaidOrder(client);

    // Add fulfillment to the order
    const { order } = await client.gql(`query ($id: ID!) { order(id: $id) { lines { id } } }`, {
        id: orderId,
    });

    const { fulfillmentHandlers } = await client.gql(`query { fulfillmentHandlers { code } }`);

    await client.gql(
        `
        mutation ($input: FulfillOrderInput!) {
            addFulfillmentToOrder(input: $input) {
                ... on Fulfillment { id state }
                ... on ErrorResult { errorCode message }
            }
        }
    `,
        {
            input: {
                lines: order.lines.map((line: { id: string }) => ({
                    orderLineId: line.id,
                    quantity: 1,
                })),
                handler: {
                    code: fulfillmentHandlers[0].code,
                    arguments: [
                        { name: 'method', value: 'test-method' },
                        { name: 'trackingCode', value: '' },
                    ],
                },
            },
        },
    );

    return orderId;
}

/**
 * Creates a payment method (idempotent), builds a fully-paid order via the
 * Admin API, and returns the order ID in "PaymentSettled" state.
 */
async function createPaidOrder(client: VendureAdminClient): Promise<string> {
    // Ensure a payment method exists
    const { paymentMethods } = await client.gql(`query { paymentMethods { items { id } } }`);
    if (paymentMethods.items.length === 0) {
        await client.gql(`
            mutation {
                createPaymentMethod(input: {
                    code: "test-payment"
                    enabled: true
                    handler: {
                        code: "dummy-payment-handler",
                        arguments: [{ name: "automaticSettle", value: "true" }]
                    }
                    translations: [{ languageCode: en, name: "Test Payment", description: "" }]
                }) { id }
            }
        `);
    }

    const { createDraftOrder } = await client.gql(`mutation { createDraftOrder { id } }`);
    const orderId: string = createDraftOrder.id;

    const { customers } = await client.gql(`query { customers(options: { take: 1 }) { items { id } } }`);
    await client.gql(
        `
        mutation ($orderId: ID!, $customerId: ID!) {
            setCustomerForDraftOrder(orderId: $orderId, customerId: $customerId) {
                ... on Order { id } ... on ErrorResult { errorCode message }
            }
        }
    `,
        { orderId, customerId: customers.items[0].id },
    );

    const { productVariants } = await client.gql(
        `query { productVariants(options: { take: 1 }) { items { id } } }`,
    );
    await client.gql(
        `
        mutation ($orderId: ID!, $variantId: ID!) {
            addItemToDraftOrder(orderId: $orderId, input: {
                productVariantId: $variantId, quantity: 1
            }) { ... on Order { id } ... on ErrorResult { errorCode message } }
        }
    `,
        { orderId, variantId: productVariants.items[0].id },
    );

    await client.gql(
        `
        mutation ($orderId: ID!) {
            setDraftOrderShippingAddress(orderId: $orderId, input: {
                fullName: "Test User", streetLine1: "123 Main St",
                city: "London", countryCode: "GB"
            }) { id }
        }
    `,
        { orderId },
    );

    const { eligibleShippingMethodsForDraftOrder: methods } = await client.gql(
        `
        query ($orderId: ID!) {
            eligibleShippingMethodsForDraftOrder(orderId: $orderId) { id }
        }
    `,
        { orderId },
    );
    await client.gql(
        `
        mutation ($orderId: ID!, $methodId: ID!) {
            setDraftOrderShippingMethod(orderId: $orderId, shippingMethodId: $methodId) {
                ... on Order { id } ... on ErrorResult { errorCode message }
            }
        }
    `,
        { orderId, methodId: methods[0].id },
    );

    await client.gql(
        `
        mutation ($id: ID!) {
            transitionOrderToState(id: $id, state: "ArrangingPayment") {
                ... on Order { id state }
                ... on OrderStateTransitionError { errorCode message transitionError }
            }
        }
    `,
        { id: orderId },
    );

    await client.gql(
        `
        mutation ($orderId: ID!) {
            addManualPaymentToOrder(input: {
                orderId: $orderId, method: "test-payment",
                transactionId: "e2e-test-tx-${orderId}", metadata: {}
            }) { ... on Order { id state } ... on ErrorResult { errorCode message } }
        }
    `,
        { orderId },
    );

    return orderId;
}

/**
 * Creates a fully-paid order and transitions it to the "Modifying" state.
 */
async function createModifyingOrder(page: Page): Promise<string> {
    const client = new VendureAdminClient(page);
    await client.login();
    const orderId = await createPaidOrder(client);

    await client.gql(
        `
        mutation ($id: ID!) {
            transitionOrderToState(id: $id, state: "Modifying") {
                ... on Order { id state }
                ... on OrderStateTransitionError { errorCode message transitionError }
            }
        }
    `,
        { id: orderId },
    );

    return orderId;
}

/**
 * Opens the refund dialog from the order detail page via the action bar dropdown.
 */
async function openRefundDialog(page: Page) {
    const actionBarEllipsis = page.getByTestId('action-bar-dropdown-trigger');
    await expect(actionBarEllipsis).toBeVisible({ timeout: 10_000 });
    await actionBarEllipsis.click();

    const menu = page.locator('[data-slot="dropdown-menu-content"]');
    await menu
        .getByText(/Refund/i)
        .first()
        .click();
}
