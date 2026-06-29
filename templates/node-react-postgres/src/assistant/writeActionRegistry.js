import { createWriteActionRegistry } from '@oninova/personal-software-assistant';

export const createProjectWriteActionRegistry = () => createWriteActionRegistry({
  actions: [
    // Add narrow, reviewed write handlers here when a host app needs them.
    // Example: update_product_price -> update one approved price column after full_admin approval.
  ],
});
