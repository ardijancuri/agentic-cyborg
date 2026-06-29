<?php
/**
 * Plugin Name: Oninova Personal Assistant for WooCommerce
 * Description: Adds an approved AI assistant drawer for WooCommerce store operations.
 * Version: 0.1.3
 * Author: Oninova
 * Requires Plugins: woocommerce
 */

if (!defined('ABSPATH')) {
    exit;
}

define('PSA_WC_ASSISTANT_VERSION', '0.1.3');
define('PSA_WC_ASSISTANT_REST_NAMESPACE', 'oninova-assistant/v1');
define('PSA_WC_OPTION_MODE', 'psa_wc_assistant_mode');
define('PSA_WC_OPTION_OPENAI_API_KEY', 'psa_wc_assistant_openai_api_key');
define('PSA_WC_OPTION_OPENAI_MODEL', 'psa_wc_assistant_openai_model');
define('PSA_WC_OPTION_SERVICE_URL', 'psa_wc_assistant_service_url');
define('PSA_WC_OPTION_SITE_ID', 'psa_wc_assistant_site_id');
define('PSA_WC_OPTION_SITE_SECRET', 'psa_wc_assistant_site_secret');
define('PSA_WC_DEFAULT_OPENAI_MODEL', 'gpt-5.4-mini');

function psa_wc_assistant_table($name) {
    global $wpdb;
    return $wpdb->prefix . 'psa_assistant_' . $name;
}

function psa_wc_assistant_now() {
    return current_time('mysql', true);
}

function psa_wc_json_encode($value) {
    return wp_json_encode(is_array($value) ? $value : array());
}

function psa_wc_json_decode($value) {
    $decoded = json_decode((string) $value, true);
    return is_array($decoded) ? $decoded : array();
}

function psa_wc_admin_path($relative) {
    $url = admin_url($relative);
    $parts = wp_parse_url($url);
    $path = isset($parts['path']) ? $parts['path'] : '/wp-admin/' . ltrim($relative, '/');
    $query = isset($parts['query']) ? '?' . $parts['query'] : '';
    return $path . $query;
}

function psa_wc_assistant_activate() {
    if (!get_option(PSA_WC_OPTION_MODE)) {
        update_option(PSA_WC_OPTION_MODE, 'direct', false);
    }

    if (!get_option(PSA_WC_OPTION_OPENAI_MODEL)) {
        update_option(PSA_WC_OPTION_OPENAI_MODEL, PSA_WC_DEFAULT_OPENAI_MODEL, false);
    }

    if (!get_option(PSA_WC_OPTION_SITE_ID)) {
        update_option(PSA_WC_OPTION_SITE_ID, wp_generate_uuid4(), false);
    }

    if (!get_option(PSA_WC_OPTION_SITE_SECRET)) {
        update_option(PSA_WC_OPTION_SITE_SECRET, wp_generate_password(64, false, false), false);
    }

    require_once ABSPATH . 'wp-admin/includes/upgrade.php';

    global $wpdb;
    $charset_collate = $wpdb->get_charset_collate();
    $conversations = psa_wc_assistant_table('conversations');
    $messages = psa_wc_assistant_table('messages');
    $context_documents = psa_wc_assistant_table('context_documents');
    $draft_actions = psa_wc_assistant_table('draft_actions');
    $tool_runs = psa_wc_assistant_table('tool_runs');

    dbDelta("CREATE TABLE {$conversations} (
        id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
        user_id bigint(20) unsigned NULL,
        title varchar(255) NOT NULL DEFAULT 'Business assistant chat',
        metadata longtext NOT NULL,
        created_at datetime NOT NULL,
        updated_at datetime NOT NULL,
        PRIMARY KEY  (id),
        KEY user_updated (user_id, updated_at)
    ) {$charset_collate};");

    dbDelta("CREATE TABLE {$messages} (
        id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
        conversation_id bigint(20) unsigned NOT NULL,
        role varchar(32) NOT NULL,
        content longtext NOT NULL,
        metadata longtext NOT NULL,
        created_at datetime NOT NULL,
        PRIMARY KEY  (id),
        KEY conversation_created (conversation_id, created_at)
    ) {$charset_collate};");

    dbDelta("CREATE TABLE {$context_documents} (
        id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
        scope varchar(128) NOT NULL,
        title varchar(255) NOT NULL,
        content longtext NOT NULL,
        metadata longtext NOT NULL,
        source_hash varchar(128) NOT NULL,
        created_by bigint(20) unsigned NULL,
        refreshed_at datetime NOT NULL,
        created_at datetime NOT NULL,
        updated_at datetime NOT NULL,
        PRIMARY KEY  (id),
        UNIQUE KEY scope (scope)
    ) {$charset_collate};");

    dbDelta("CREATE TABLE {$draft_actions} (
        id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
        conversation_id bigint(20) unsigned NULL,
        message_id bigint(20) unsigned NULL,
        type varchar(64) NOT NULL,
        title varchar(255) NOT NULL,
        reason longtext NOT NULL,
        target_route varchar(500) NULL,
        payload longtext NOT NULL,
        confidence decimal(4,3) NOT NULL DEFAULT 0,
        requires_user_review tinyint(1) NOT NULL DEFAULT 1,
        status varchar(32) NOT NULL DEFAULT 'draft',
        metadata longtext NOT NULL,
        created_at datetime NOT NULL,
        PRIMARY KEY  (id),
        KEY conversation_created (conversation_id, created_at)
    ) {$charset_collate};");

    dbDelta("CREATE TABLE {$tool_runs} (
        id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
        conversation_id bigint(20) unsigned NULL,
        message_id bigint(20) unsigned NULL,
        tool_name varchar(128) NOT NULL,
        arguments longtext NOT NULL,
        result_summary longtext NULL,
        status varchar(32) NOT NULL DEFAULT 'completed',
        error longtext NULL,
        duration_ms int NULL,
        created_at datetime NOT NULL,
        PRIMARY KEY  (id),
        KEY conversation_created (conversation_id, created_at)
    ) {$charset_collate};");
}
register_activation_hook(__FILE__, 'psa_wc_assistant_activate');

function psa_wc_assistant_can_use() {
    return current_user_can('manage_woocommerce');
}

function psa_wc_assistant_register_menu() {
    $capability = 'manage_woocommerce';
    $callback = 'psa_wc_assistant_render_admin_page';

    if (class_exists('WooCommerce')) {
        add_submenu_page(
            'woocommerce',
            __('AI Assistant', 'oninova-personal-assistant'),
            __('AI Assistant', 'oninova-personal-assistant'),
            $capability,
            'oninova-ai-assistant',
            $callback
        );
        return;
    }

    add_menu_page(
        __('AI Assistant', 'oninova-personal-assistant'),
        __('AI Assistant', 'oninova-personal-assistant'),
        $capability,
        'oninova-ai-assistant',
        $callback,
        'dashicons-format-chat',
        58
    );
}
add_action('admin_menu', 'psa_wc_assistant_register_menu');

function psa_wc_assistant_handle_settings() {
    if (!psa_wc_assistant_can_use()) {
        wp_die(esc_html__('Insufficient permissions.', 'oninova-personal-assistant'));
    }

    check_admin_referer('psa_wc_assistant_settings');

    $mode = isset($_POST['assistant_mode']) ? sanitize_key(wp_unslash($_POST['assistant_mode'])) : 'direct';
    $openai_api_key = isset($_POST['openai_api_key']) ? sanitize_text_field(wp_unslash($_POST['openai_api_key'])) : '';
    $openai_model = isset($_POST['openai_model']) ? sanitize_text_field(wp_unslash($_POST['openai_model'])) : PSA_WC_DEFAULT_OPENAI_MODEL;
    $service_url = isset($_POST['service_url']) ? esc_url_raw(wp_unslash($_POST['service_url'])) : '';
    $site_id = isset($_POST['site_id']) ? sanitize_text_field(wp_unslash($_POST['site_id'])) : '';
    $site_secret = isset($_POST['site_secret']) ? sanitize_text_field(wp_unslash($_POST['site_secret'])) : '';

    update_option(PSA_WC_OPTION_MODE, in_array($mode, array('direct', 'service'), true) ? $mode : 'direct', false);
    update_option(PSA_WC_OPTION_OPENAI_MODEL, $openai_model !== '' ? $openai_model : PSA_WC_DEFAULT_OPENAI_MODEL, false);
    if ($openai_api_key !== '') {
        update_option(PSA_WC_OPTION_OPENAI_API_KEY, $openai_api_key, false);
    }
    if (isset($_POST['clear_openai_api_key']) && $_POST['clear_openai_api_key'] === '1') {
        delete_option(PSA_WC_OPTION_OPENAI_API_KEY);
    }

    update_option(PSA_WC_OPTION_SERVICE_URL, untrailingslashit($service_url), false);
    if ($site_id !== '') {
        update_option(PSA_WC_OPTION_SITE_ID, $site_id, false);
    }
    if ($site_secret !== '') {
        update_option(PSA_WC_OPTION_SITE_SECRET, $site_secret, false);
    }

    wp_safe_redirect(add_query_arg(array('page' => 'oninova-ai-assistant', 'settings-updated' => '1'), admin_url('admin.php')));
    exit;
}
add_action('admin_post_psa_wc_assistant_settings', 'psa_wc_assistant_handle_settings');

function psa_wc_assistant_render_admin_page() {
    if (!psa_wc_assistant_can_use()) {
        wp_die(esc_html__('Insufficient permissions.', 'oninova-personal-assistant'));
    }

    $service_url = get_option(PSA_WC_OPTION_SERVICE_URL, '');
    $site_id = get_option(PSA_WC_OPTION_SITE_ID, '');
    $mode = get_option(PSA_WC_OPTION_MODE, 'direct');
    $openai_model = get_option(PSA_WC_OPTION_OPENAI_MODEL, PSA_WC_DEFAULT_OPENAI_MODEL);
    $has_openai_key = get_option(PSA_WC_OPTION_OPENAI_API_KEY, '') !== '';
    ?>
    <div class="wrap psa-wc-admin-page">
        <h1><?php echo esc_html__('AI Assistant', 'oninova-personal-assistant'); ?></h1>

        <?php if (isset($_GET['settings-updated'])) : ?>
            <div class="notice notice-success is-dismissible"><p><?php echo esc_html__('Assistant settings saved.', 'oninova-personal-assistant'); ?></p></div>
        <?php endif; ?>

        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="psa-wc-settings">
            <?php wp_nonce_field('psa_wc_assistant_settings'); ?>
            <input type="hidden" name="action" value="psa_wc_assistant_settings" />
            <h2><?php echo esc_html__('Easy setup', 'oninova-personal-assistant'); ?></h2>
            <p><?php echo esc_html__('For most WooCommerce stores, paste an OpenAI API key here and start using the assistant. The key is saved in WordPress options and is not exposed to the assistant chat JavaScript.', 'oninova-personal-assistant'); ?></p>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><?php echo esc_html__('Assistant mode', 'oninova-personal-assistant'); ?></th>
                    <td>
                        <label><input type="radio" name="assistant_mode" value="direct" <?php checked($mode, 'direct'); ?> /> <?php echo esc_html__('Easy: WordPress calls OpenAI directly', 'oninova-personal-assistant'); ?></label><br />
                        <label><input type="radio" name="assistant_mode" value="service" <?php checked($mode, 'service'); ?> /> <?php echo esc_html__('Advanced: use central assistant service', 'oninova-personal-assistant'); ?></label>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="psa-openai-api-key"><?php echo esc_html__('OpenAI API key', 'oninova-personal-assistant'); ?></label></th>
                    <td>
                        <input id="psa-openai-api-key" class="regular-text" type="password" name="openai_api_key" value="" placeholder="<?php echo esc_attr($has_openai_key ? __('Key saved. Leave blank to keep current key.', 'oninova-personal-assistant') : __('Paste OpenAI API key', 'oninova-personal-assistant')); ?>" autocomplete="off" />
                        <?php if ($has_openai_key) : ?>
                            <label style="display:block;margin-top:8px;"><input type="checkbox" name="clear_openai_api_key" value="1" /> <?php echo esc_html__('Clear saved OpenAI key', 'oninova-personal-assistant'); ?></label>
                        <?php endif; ?>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="psa-openai-model"><?php echo esc_html__('OpenAI model', 'oninova-personal-assistant'); ?></label></th>
                    <td><input id="psa-openai-model" class="regular-text" type="text" name="openai_model" value="<?php echo esc_attr($openai_model); ?>" /></td>
                </tr>
            </table>

            <div class="psa-wc-service-settings" <?php echo $mode === 'service' ? '' : 'style="display:none;"'; ?>>
                <h2><?php echo esc_html__('Advanced central service', 'oninova-personal-assistant'); ?></h2>
                <p><?php echo esc_html__('Use this mode when one assistant service should support many stores or when you do not want OpenAI keys stored in WordPress.', 'oninova-personal-assistant'); ?></p>
                <table class="form-table" role="presentation">
                    <tr>
                        <th scope="row"><label for="psa-service-url"><?php echo esc_html__('Assistant service URL', 'oninova-personal-assistant'); ?></label></th>
                        <td><input id="psa-service-url" class="regular-text" type="url" name="service_url" value="<?php echo esc_attr($service_url); ?>" placeholder="https://assistant.example.com" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="psa-site-id"><?php echo esc_html__('Site ID', 'oninova-personal-assistant'); ?></label></th>
                        <td><input id="psa-site-id" class="regular-text" type="text" name="site_id" value="<?php echo esc_attr($site_id); ?>" /></td>
                    </tr>
                    <tr>
                        <th scope="row"><label for="psa-site-secret"><?php echo esc_html__('Site secret', 'oninova-personal-assistant'); ?></label></th>
                        <td><input id="psa-site-secret" class="regular-text" type="password" name="site_secret" value="" placeholder="<?php echo esc_attr__('Leave blank to keep current secret', 'oninova-personal-assistant'); ?>" /></td>
                    </tr>
                </table>
            </div>
            <?php submit_button(__('Save assistant settings', 'oninova-personal-assistant')); ?>
        </form>

        <div id="psa-assistant-root"></div>
    </div>
    <?php
}

function psa_wc_assistant_should_enqueue($hook) {
    if (!psa_wc_assistant_can_use()) {
        return false;
    }

    if ($hook === 'woocommerce_page_oninova-ai-assistant' || $hook === 'toplevel_page_oninova-ai-assistant') {
        return true;
    }

    $screen = function_exists('get_current_screen') ? get_current_screen() : null;
    if (!$screen) {
        return false;
    }

    $screen_id = isset($screen->id) ? (string) $screen->id : '';
    $post_type = isset($screen->post_type) ? (string) $screen->post_type : '';

    return strpos($screen_id, 'woocommerce') !== false
        || in_array($post_type, array('product', 'shop_order', 'shop_coupon'), true);
}

function psa_wc_assistant_enqueue_admin($hook) {
    if (!psa_wc_assistant_should_enqueue($hook)) {
        return;
    }

    $asset_url = plugin_dir_url(__FILE__) . 'assets/';
    wp_enqueue_style('psa-wc-assistant-admin', $asset_url . 'admin.css', array(), PSA_WC_ASSISTANT_VERSION);
    wp_enqueue_script('psa-wc-assistant-admin', $asset_url . 'admin.js', array(), PSA_WC_ASSISTANT_VERSION, true);
    wp_localize_script('psa-wc-assistant-admin', 'PsaAssistantConfig', array(
        'restUrl' => esc_url_raw(rest_url(PSA_WC_ASSISTANT_REST_NAMESPACE . '/')),
        'nonce' => wp_create_nonce('wp_rest'),
        'locale' => determine_locale(),
        'canApply' => psa_wc_assistant_can_use(),
        'adminUrl' => admin_url(),
    ));
}
add_action('admin_enqueue_scripts', 'psa_wc_assistant_enqueue_admin');

function psa_wc_assistant_register_rest_routes() {
    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/chat', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'psa_wc_assistant_rest_chat',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/conversations', array(
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'psa_wc_assistant_rest_conversations',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/conversations/(?P<id>\d+)', array(
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'psa_wc_assistant_rest_conversation',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/context', array(
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'psa_wc_assistant_rest_context',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/context/refresh', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'psa_wc_assistant_rest_context_refresh',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/draft-actions/(?P<id>\d+)/apply', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'psa_wc_assistant_rest_apply_draft_action',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/draft-actions/(?P<id>\d+)/reject', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'psa_wc_assistant_rest_reject_draft_action',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/tools/run', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'psa_wc_assistant_rest_run_tool',
        'permission_callback' => 'psa_wc_assistant_can_run_signed_tool',
    ));
}
add_action('rest_api_init', 'psa_wc_assistant_register_rest_routes');

function psa_wc_assistant_tool_definitions() {
    return array(
        array(
            'type' => 'function',
            'name' => 'get_store_overview',
            'description' => 'Read-only WooCommerce store profile, currency, and basic status.',
            'parameters' => array('type' => 'object', 'properties' => new stdClass(), 'additionalProperties' => false),
        ),
        array(
            'type' => 'function',
            'name' => 'get_sales_summary',
            'description' => 'Read-only WooCommerce sales totals for a selected period.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array('period' => array('type' => 'string', 'enum' => array('today', 'week', 'month', 'year', 'all'))),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_order_summary',
            'description' => 'Read-only recent WooCommerce order counts and order list.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array('limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20)),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_product_summary',
            'description' => 'Read-only WooCommerce product and inventory summary.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array('limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20)),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'find_products',
            'description' => 'Read-only WooCommerce product lookup by search text before price draft actions.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'search' => array('type' => 'string'),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_product_categories',
            'description' => 'Read-only WooCommerce product category lookup by name/slug before category bulk price draft actions.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'search' => array('type' => 'string'),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 50),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'find_products_by_category',
            'description' => 'Read-only WooCommerce product lookup by product category, including current regular and sale prices.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'categoryId' => array('type' => 'integer'),
                    'categorySlug' => array('type' => 'string'),
                    'categoryName' => array('type' => 'string'),
                    'includeVariations' => array('type' => 'boolean'),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 100),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_low_stock_products',
            'description' => 'Read-only WooCommerce products with low managed stock.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array('limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20)),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_customer_summary',
            'description' => 'Read-only WooCommerce customer summary.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array('limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20)),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_coupon_summary',
            'description' => 'Read-only WooCommerce coupon summary.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array('limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20)),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_refund_summary',
            'description' => 'Read-only WooCommerce refund summary.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array('limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20)),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_operational_alerts',
            'description' => 'Read-only WooCommerce alerts for low stock and orders needing attention.',
            'parameters' => array('type' => 'object', 'properties' => new stdClass(), 'additionalProperties' => false),
        ),
    );
}

function psa_wc_assistant_page_registry() {
    return array(
        array(
            'id' => 'woocommerce_home',
            'label' => 'WooCommerce Home',
            'route' => psa_wc_admin_path('admin.php?page=wc-admin'),
            'description' => 'WooCommerce dashboard and store overview.',
            'actionTypes' => array('open_page', 'operational_note'),
            'keywords' => array('dashboard', 'overview', 'store'),
        ),
        array(
            'id' => 'orders',
            'label' => 'Orders',
            'route' => psa_wc_admin_path('admin.php?page=wc-orders'),
            'description' => 'WooCommerce orders and order management.',
            'actionTypes' => array('review_order', 'review_report'),
            'keywords' => array('order', 'orders', 'sales'),
        ),
        array(
            'id' => 'products',
            'label' => 'Products',
            'route' => psa_wc_admin_path('edit.php?post_type=product'),
            'description' => 'WooCommerce products, variations, prices, and stock.',
            'actionTypes' => array('review_product', 'review_stock', 'update_woocommerce_product_price', 'bulk_update_woocommerce_product_prices', 'bulk_update_woocommerce_category_product_prices'),
            'keywords' => array('product', 'products', 'stock', 'inventory', 'price'),
        ),
        array(
            'id' => 'analytics',
            'label' => 'Analytics',
            'route' => psa_wc_admin_path('admin.php?page=wc-admin&path=/analytics/overview'),
            'description' => 'WooCommerce analytics and sales reports.',
            'actionTypes' => array('review_report'),
            'keywords' => array('analytics', 'reports', 'revenue'),
        ),
        array(
            'id' => 'customers',
            'label' => 'Customers',
            'route' => psa_wc_admin_path('admin.php?page=wc-admin&path=/customers'),
            'description' => 'WooCommerce customers.',
            'actionTypes' => array('follow_up_client', 'review_customer'),
            'keywords' => array('customer', 'customers', 'client'),
        ),
        array(
            'id' => 'coupons',
            'label' => 'Coupons',
            'route' => psa_wc_admin_path('edit.php?post_type=shop_coupon'),
            'description' => 'WooCommerce coupons.',
            'actionTypes' => array('review_coupon'),
            'keywords' => array('coupon', 'coupons', 'discount'),
        ),
        array(
            'id' => 'settings',
            'label' => 'Settings',
            'route' => psa_wc_admin_path('admin.php?page=wc-settings'),
            'description' => 'WooCommerce settings.',
            'keywords' => array('settings', 'configuration'),
        ),
    );
}

function psa_wc_assistant_write_actions() {
    return array(
        array(
            'type' => 'update_woocommerce_product_price',
            'handlerName' => 'update_woocommerce_product_price',
            'title' => 'Update WooCommerce product price',
            'description' => 'Update one simple product or variation regular_price/sale_price after WooCommerce manager approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('productId', 'variationId', 'priceField', 'currentPrice', 'newPrice', 'currency', 'reason'),
                'properties' => array(
                    'productId' => array('type' => 'integer'),
                    'variationId' => array('type' => array('integer', 'null')),
                    'priceField' => array('type' => 'string', 'enum' => array('regular_price', 'sale_price')),
                    'currentPrice' => array('type' => 'string'),
                    'newPrice' => array('type' => 'string'),
                    'currency' => array('type' => 'string'),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'bulk_update_woocommerce_product_prices',
            'handlerName' => 'bulk_update_woocommerce_product_prices',
            'title' => 'Bulk update WooCommerce product prices',
            'description' => 'Update regular_price or sale_price for a bounded list of simple products or variations after WooCommerce manager approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('items', 'currency', 'reason'),
                'properties' => array(
                    'priceField' => array('type' => 'string', 'enum' => array('regular_price', 'sale_price')),
                    'currency' => array('type' => 'string'),
                    'reason' => array('type' => 'string'),
                    'items' => array(
                        'type' => 'array',
                        'minItems' => 1,
                        'maxItems' => 50,
                        'items' => array(
                            'type' => 'object',
                            'required' => array('productId', 'currentPrice', 'newPrice'),
                            'properties' => array(
                                'productId' => array('type' => 'integer'),
                                'variationId' => array('type' => array('integer', 'null')),
                                'priceField' => array('type' => 'string', 'enum' => array('regular_price', 'sale_price')),
                                'currentPrice' => array('type' => 'string'),
                                'newPrice' => array('type' => 'string'),
                            ),
                            'additionalProperties' => false,
                        ),
                    ),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'bulk_update_woocommerce_category_product_prices',
            'handlerName' => 'bulk_update_woocommerce_category_product_prices',
            'title' => 'Bulk update WooCommerce category product prices',
            'description' => 'Update regular_price or sale_price for all simple products/variations in a WooCommerce product category after WooCommerce manager approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('priceField', 'operation', 'currency', 'reason'),
                'properties' => array(
                    'categoryId' => array('type' => 'integer'),
                    'categorySlug' => array('type' => 'string'),
                    'categoryName' => array('type' => 'string'),
                    'priceField' => array('type' => 'string', 'enum' => array('regular_price', 'sale_price')),
                    'operation' => array('type' => 'string', 'enum' => array('set_fixed', 'decrease_percent', 'increase_percent', 'set_percent_of_regular_price', 'clear_sale_price')),
                    'newPrice' => array('type' => 'string'),
                    'percent' => array('type' => 'number'),
                    'includeVariations' => array('type' => 'boolean'),
                    'maxItems' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 100),
                    'currency' => array('type' => 'string'),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
    );
}

function psa_wc_assistant_make_title($message) {
    $clean = trim(preg_replace('/\s+/', ' ', (string) $message));
    if ($clean === '') {
        return 'Business assistant chat';
    }

    return strlen($clean) > 80 ? substr($clean, 0, 77) . '...' : $clean;
}

function psa_wc_assistant_create_conversation($title, $metadata = array()) {
    global $wpdb;
    $now = psa_wc_assistant_now();
    $wpdb->insert(psa_wc_assistant_table('conversations'), array(
        'user_id' => get_current_user_id(),
        'title' => $title,
        'metadata' => psa_wc_json_encode($metadata),
        'created_at' => $now,
        'updated_at' => $now,
    ), array('%d', '%s', '%s', '%s', '%s'));

    return psa_wc_assistant_get_conversation((int) $wpdb->insert_id);
}

function psa_wc_assistant_get_conversation($id) {
    global $wpdb;
    $table = psa_wc_assistant_table('conversations');
    $user_id = get_current_user_id();
    $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d AND user_id = %d", $id, $user_id), ARRAY_A);
    return $row ? psa_wc_assistant_serialize_conversation($row) : null;
}

function psa_wc_assistant_get_or_create_conversation($conversation_id, $first_message) {
    if ($conversation_id) {
        $existing = psa_wc_assistant_get_conversation($conversation_id);
        if ($existing) {
            return $existing;
        }
    }

    return psa_wc_assistant_create_conversation(psa_wc_assistant_make_title($first_message), array('source' => 'wordpress_admin'));
}

function psa_wc_assistant_list_conversations($limit = 20) {
    global $wpdb;
    $table = psa_wc_assistant_table('conversations');
    $safe_limit = max(1, min(absint($limit), 50));
    $user_id = get_current_user_id();
    $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE user_id = %d ORDER BY updated_at DESC LIMIT %d", $user_id, $safe_limit), ARRAY_A);
    return array_map('psa_wc_assistant_serialize_conversation', $rows);
}

function psa_wc_assistant_add_message($conversation_id, $role, $content, $metadata = array()) {
    global $wpdb;
    $now = psa_wc_assistant_now();
    $wpdb->insert(psa_wc_assistant_table('messages'), array(
        'conversation_id' => $conversation_id,
        'role' => $role,
        'content' => (string) $content,
        'metadata' => psa_wc_json_encode($metadata),
        'created_at' => $now,
    ), array('%d', '%s', '%s', '%s', '%s'));

    $wpdb->update(psa_wc_assistant_table('conversations'), array('updated_at' => $now), array('id' => $conversation_id), array('%s'), array('%d'));

    return psa_wc_assistant_get_message((int) $wpdb->insert_id);
}

function psa_wc_assistant_get_message($id) {
    global $wpdb;
    $table = psa_wc_assistant_table('messages');
    $row = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$table} WHERE id = %d", $id), ARRAY_A);
    return $row ? psa_wc_assistant_serialize_message($row) : null;
}

function psa_wc_assistant_list_messages($conversation_id, $limit = 50) {
    global $wpdb;
    $table = psa_wc_assistant_table('messages');
    $safe_limit = max(1, min(absint($limit), 100));
    $rows = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$table} WHERE conversation_id = %d ORDER BY created_at DESC LIMIT %d", $conversation_id, $safe_limit), ARRAY_A);
    $rows = array_reverse($rows);
    return array_map('psa_wc_assistant_serialize_message', $rows);
}

function psa_wc_assistant_serialize_conversation($row) {
    return array(
        'id' => (int) $row['id'],
        'title' => $row['title'],
        'metadata' => psa_wc_json_decode($row['metadata']),
        'createdAt' => $row['created_at'],
        'updatedAt' => $row['updated_at'],
    );
}

function psa_wc_assistant_serialize_message($row) {
    return array(
        'id' => (int) $row['id'],
        'conversationId' => (int) $row['conversation_id'],
        'role' => $row['role'],
        'content' => $row['content'],
        'metadata' => psa_wc_json_decode($row['metadata']),
        'createdAt' => $row['created_at'],
    );
}

function psa_wc_assistant_serialize_context_document($row, $include_content = false) {
    $document = array(
        'id' => (int) $row['id'],
        'scope' => $row['scope'],
        'title' => $row['title'],
        'metadata' => psa_wc_json_decode($row['metadata']),
        'sourceHash' => $row['source_hash'],
        'refreshedAt' => $row['refreshed_at'],
    );

    if ($include_content) {
        $document['content'] = $row['content'];
    } else {
        $document['preview'] = substr($row['content'], 0, 360);
    }

    return $document;
}

function psa_wc_assistant_list_context_documents($include_content = false) {
    global $wpdb;
    $table = psa_wc_assistant_table('context_documents');
    $rows = $wpdb->get_results("SELECT * FROM {$table} ORDER BY scope ASC", ARRAY_A);
    return array_map(function ($row) use ($include_content) {
        return psa_wc_assistant_serialize_context_document($row, $include_content);
    }, $rows);
}

function psa_wc_assistant_upsert_context_document($scope, $title, $content, $metadata = array()) {
    global $wpdb;
    $table = psa_wc_assistant_table('context_documents');
    $now = psa_wc_assistant_now();
    $existing_id = $wpdb->get_var($wpdb->prepare("SELECT id FROM {$table} WHERE scope = %s", $scope));
    $data = array(
        'scope' => $scope,
        'title' => $title,
        'content' => $content,
        'metadata' => psa_wc_json_encode($metadata),
        'source_hash' => hash('sha256', $content),
        'created_by' => get_current_user_id(),
        'refreshed_at' => $now,
        'updated_at' => $now,
    );

    if ($existing_id) {
        $wpdb->update($table, $data, array('id' => (int) $existing_id));
    } else {
        $data['created_at'] = $now;
        $wpdb->insert($table, $data);
    }
}

function psa_wc_assistant_refresh_context_documents() {
    $store = psa_wc_assistant_run_tool_by_name('get_store_overview', array());
    $sales = psa_wc_assistant_run_tool_by_name('get_sales_summary', array('period' => 'month'));
    $orders = psa_wc_assistant_run_tool_by_name('get_order_summary', array('limit' => 8));
    $products = psa_wc_assistant_run_tool_by_name('get_product_summary', array('limit' => 10));
    $alerts = psa_wc_assistant_run_tool_by_name('get_operational_alerts', array());

    $documents = array(
        array(
            'scope' => 'store_profile',
            'title' => 'WooCommerce Store Profile',
            'content' => "# WooCommerce Store Profile\n\n" . psa_wc_assistant_markdown_kv($store['data']),
            'metadata' => array('tool' => 'get_store_overview'),
        ),
        array(
            'scope' => 'module_map',
            'title' => 'WooCommerce Module Map',
            'content' => "# WooCommerce Module Map\n\n" . psa_wc_assistant_markdown_pages(psa_wc_assistant_page_registry()),
            'metadata' => array('source' => 'page_registry'),
        ),
        array(
            'scope' => 'dashboard_snapshot',
            'title' => 'Current Dashboard Snapshot',
            'content' => "# Current Dashboard Snapshot\n\n## Sales\n" . psa_wc_assistant_markdown_kv($sales['data']) . "\n\n## Orders\n" . psa_wc_assistant_markdown_list($orders['data']['orders']),
            'metadata' => array('tools' => array('get_sales_summary', 'get_order_summary')),
        ),
        array(
            'scope' => 'product_inventory_summary',
            'title' => 'Product And Inventory Summary',
            'content' => "# Product And Inventory Summary\n\n" . psa_wc_assistant_markdown_kv($products['data']) . "\n\n## Low Stock\n" . psa_wc_assistant_markdown_list($alerts['data']['lowStock']),
            'metadata' => array('tools' => array('get_product_summary', 'get_operational_alerts')),
        ),
        array(
            'scope' => 'operational_risks',
            'title' => 'Operational Risks',
            'content' => "# Operational Risks\n\n" . psa_wc_assistant_markdown_kv($alerts['data']),
            'metadata' => array('tool' => 'get_operational_alerts'),
        ),
    );

    foreach ($documents as $document) {
        psa_wc_assistant_upsert_context_document($document['scope'], $document['title'], $document['content'], $document['metadata']);
    }

    return psa_wc_assistant_list_context_documents(false);
}

function psa_wc_assistant_markdown_kv($data) {
    if (!is_array($data)) {
        return '- none';
    }

    $lines = array();
    foreach ($data as $key => $value) {
        if (is_array($value)) {
            $lines[] = '- ' . $key . ': ' . wp_json_encode($value);
        } else {
            $lines[] = '- ' . $key . ': ' . (string) $value;
        }
    }

    return implode("\n", $lines);
}

function psa_wc_assistant_markdown_list($items) {
    if (!is_array($items) || count($items) === 0) {
        return '- none';
    }

    return implode("\n", array_map(function ($item) {
        return '- ' . (is_array($item) ? wp_json_encode($item) : (string) $item);
    }, $items));
}

function psa_wc_assistant_markdown_pages($pages) {
    return implode("\n", array_map(function ($page) {
        return '- ' . $page['id'] . ': ' . $page['label'] . ' -> ' . $page['route'];
    }, $pages));
}

function psa_wc_assistant_serialize_draft_action($row) {
    return array(
        'id' => (int) $row['id'],
        'conversationId' => isset($row['conversation_id']) ? (int) $row['conversation_id'] : null,
        'messageId' => isset($row['message_id']) ? (int) $row['message_id'] : null,
        'type' => $row['type'],
        'title' => $row['title'],
        'reason' => $row['reason'],
        'targetRoute' => $row['target_route'],
        'payload' => psa_wc_json_decode($row['payload']),
        'confidence' => (float) $row['confidence'],
        'requiresUserReview' => (bool) $row['requires_user_review'],
        'status' => $row['status'],
        'metadata' => psa_wc_json_decode($row['metadata']),
    );
}

function psa_wc_assistant_add_draft_actions($conversation_id, $message_id, $actions) {
    global $wpdb;
    $saved = array();
    $table = psa_wc_assistant_table('draft_actions');
    $now = psa_wc_assistant_now();

    foreach ((array) $actions as $action) {
        $wpdb->insert($table, array(
            'conversation_id' => $conversation_id,
            'message_id' => $message_id,
            'type' => sanitize_key(isset($action['type']) ? $action['type'] : 'operational_note'),
            'title' => sanitize_text_field(isset($action['title']) ? $action['title'] : ''),
            'reason' => sanitize_textarea_field(isset($action['reason']) ? $action['reason'] : ''),
            'target_route' => esc_url_raw(isset($action['targetRoute']) ? $action['targetRoute'] : ''),
            'payload' => psa_wc_json_encode(isset($action['payload']) ? $action['payload'] : array()),
            'confidence' => isset($action['confidence']) ? (float) $action['confidence'] : 0,
            'requires_user_review' => 1,
            'status' => 'draft',
            'metadata' => psa_wc_json_encode(array()),
            'created_at' => $now,
        ));
        $saved[] = psa_wc_assistant_get_draft_action((int) $wpdb->insert_id);
    }

    return $saved;
}

function psa_wc_assistant_get_draft_action($id) {
    global $wpdb;
    $table = psa_wc_assistant_table('draft_actions');
    $conversations = psa_wc_assistant_table('conversations');
    $user_id = get_current_user_id();
    $row = $wpdb->get_row($wpdb->prepare(
        "SELECT da.* FROM {$table} da LEFT JOIN {$conversations} c ON c.id = da.conversation_id WHERE da.id = %d AND c.user_id = %d",
        $id,
        $user_id
    ), ARRAY_A);

    return $row ? psa_wc_assistant_serialize_draft_action($row) : null;
}

function psa_wc_assistant_update_draft_action_status($id, $status, $metadata = array()) {
    global $wpdb;
    $wpdb->update(psa_wc_assistant_table('draft_actions'), array(
        'status' => sanitize_key($status),
        'metadata' => psa_wc_json_encode($metadata),
    ), array('id' => $id), array('%s', '%s'), array('%d'));

    return psa_wc_assistant_get_draft_action($id);
}

function psa_wc_assistant_add_tool_run($conversation_id, $message_id, $tool_run) {
    global $wpdb;
    $wpdb->insert(psa_wc_assistant_table('tool_runs'), array(
        'conversation_id' => $conversation_id,
        'message_id' => $message_id,
        'tool_name' => sanitize_key(isset($tool_run['toolName']) ? $tool_run['toolName'] : ''),
        'arguments' => psa_wc_json_encode(isset($tool_run['args']) ? $tool_run['args'] : array()),
        'result_summary' => isset($tool_run['resultSummary']) ? sanitize_textarea_field($tool_run['resultSummary']) : null,
        'status' => sanitize_key(isset($tool_run['status']) ? $tool_run['status'] : 'completed'),
        'error' => isset($tool_run['error']) ? sanitize_textarea_field($tool_run['error']) : null,
        'duration_ms' => isset($tool_run['durationMs']) ? absint($tool_run['durationMs']) : null,
        'created_at' => psa_wc_assistant_now(),
    ));
}

function psa_wc_assistant_period_start($period) {
    $period = in_array($period, array('today', 'week', 'month', 'year', 'all'), true) ? $period : 'month';
    if ($period === 'today') {
        return gmdate('Y-m-d 00:00:00');
    }
    if ($period === 'week') {
        return gmdate('Y-m-d H:i:s', strtotime('-7 days'));
    }
    if ($period === 'month') {
        return gmdate('Y-m-d H:i:s', strtotime('-30 days'));
    }
    if ($period === 'year') {
        return gmdate('Y-m-d H:i:s', strtotime('-1 year'));
    }
    return '1970-01-01 00:00:00';
}

function psa_wc_assistant_limit($value, $default = 10, $max = 50) {
    $limit = absint($value);
    if (!$limit) {
        $limit = $default;
    }
    return max(1, min($limit, $max));
}

function psa_wc_assistant_require_woocommerce() {
    if (!function_exists('wc_get_orders') || !function_exists('wc_get_products')) {
        return new WP_Error('woocommerce_missing', 'WooCommerce is required for assistant tools.', array('status' => 400));
    }

    return true;
}

function psa_wc_assistant_run_tool_by_name($name, $args = array()) {
    $woocommerce_ready = psa_wc_assistant_require_woocommerce();
    if (is_wp_error($woocommerce_ready)) {
        return $woocommerce_ready;
    }

    $args = is_array($args) ? $args : array();

    switch ($name) {
        case 'get_store_overview':
            return psa_wc_assistant_tool_store_overview();
        case 'get_sales_summary':
            return psa_wc_assistant_tool_sales_summary($args);
        case 'get_order_summary':
            return psa_wc_assistant_tool_order_summary($args);
        case 'get_product_summary':
            return psa_wc_assistant_tool_product_summary($args);
        case 'find_products':
            return psa_wc_assistant_tool_find_products($args);
        case 'get_product_categories':
            return psa_wc_assistant_tool_product_categories($args);
        case 'find_products_by_category':
            return psa_wc_assistant_tool_find_products_by_category($args);
        case 'get_low_stock_products':
            return psa_wc_assistant_tool_low_stock_products($args);
        case 'get_customer_summary':
            return psa_wc_assistant_tool_customer_summary($args);
        case 'get_coupon_summary':
            return psa_wc_assistant_tool_coupon_summary($args);
        case 'get_refund_summary':
            return psa_wc_assistant_tool_refund_summary($args);
        case 'get_operational_alerts':
            return psa_wc_assistant_tool_operational_alerts($args);
        default:
            return new WP_Error('unknown_assistant_tool', 'Unknown assistant tool.', array('status' => 400));
    }
}

function psa_wc_assistant_category_data($term) {
    if (!$term || is_wp_error($term)) {
        return null;
    }

    return array(
        'id' => (int) $term->term_id,
        'name' => $term->name,
        'slug' => $term->slug,
        'parent' => (int) $term->parent,
        'count' => (int) $term->count,
        'adminUrl' => admin_url('term.php?taxonomy=product_cat&tag_ID=' . (int) $term->term_id . '&post_type=product'),
    );
}

function psa_wc_assistant_resolve_product_category($args) {
    $category_id = isset($args['categoryId']) ? absint($args['categoryId']) : 0;
    $category_slug = isset($args['categorySlug']) ? sanitize_title($args['categorySlug']) : '';
    $category_name = isset($args['categoryName']) ? sanitize_text_field($args['categoryName']) : '';

    if ($category_id) {
        $term = get_term($category_id, 'product_cat');
        if ($term && !is_wp_error($term)) {
            return $term;
        }
    }

    if ($category_slug !== '') {
        $term = get_term_by('slug', $category_slug, 'product_cat');
        if ($term && !is_wp_error($term)) {
            return $term;
        }
    }

    if ($category_name !== '') {
        $term = get_term_by('name', $category_name, 'product_cat');
        if ($term && !is_wp_error($term)) {
            return $term;
        }

        $matches = get_terms(array(
            'taxonomy' => 'product_cat',
            'hide_empty' => false,
            'search' => $category_name,
            'number' => 2,
        ));
        if (!is_wp_error($matches) && count($matches) === 1) {
            return $matches[0];
        }
    }

    return new WP_Error('product_category_not_found', 'Product category not found or not specific enough.', array('status' => 404));
}

function psa_wc_assistant_product_data($product) {
    if (!$product) {
        return null;
    }

    $category_terms = array();
    $category_product_id = $product->get_parent_id() ? $product->get_parent_id() : $product->get_id();
    $terms = wp_get_post_terms($category_product_id, 'product_cat');
    if (!is_wp_error($terms)) {
        foreach ($terms as $term) {
            $category_terms[] = psa_wc_assistant_category_data($term);
        }
    }

    return array(
        'id' => $product->get_id(),
        'parentId' => $product->get_parent_id(),
        'name' => $product->get_name(),
        'type' => $product->get_type(),
        'sku' => $product->get_sku(),
        'status' => $product->get_status(),
        'regularPrice' => $product->get_regular_price('edit'),
        'salePrice' => $product->get_sale_price('edit'),
        'price' => $product->get_price('edit'),
        'stockStatus' => $product->get_stock_status(),
        'managingStock' => $product->managing_stock(),
        'stockQuantity' => $product->get_stock_quantity(),
        'categories' => array_filter($category_terms),
        'permalink' => get_permalink($product->get_id()),
        'adminUrl' => get_edit_post_link($product->get_id(), 'raw'),
    );
}

function psa_wc_assistant_tool_store_overview() {
    return array(
        'summary' => 'Store overview returned',
        'data' => array(
            'siteName' => get_bloginfo('name'),
            'siteUrl' => home_url('/'),
            'currency' => function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : '',
            'currencySymbol' => function_exists('get_woocommerce_currency_symbol') ? get_woocommerce_currency_symbol() : '',
            'woocommerceVersion' => defined('WC_VERSION') ? WC_VERSION : '',
            'timezone' => wp_timezone_string(),
        ),
    );
}

function psa_wc_assistant_tool_sales_summary($args) {
    $period = isset($args['period']) ? sanitize_key($args['period']) : 'month';
    $from = psa_wc_assistant_period_start($period);
    $orders = wc_get_orders(array(
        'limit' => 100,
        'status' => array('processing', 'completed'),
        'date_created' => '>=' . $from,
        'orderby' => 'date',
        'order' => 'DESC',
    ));
    $total = 0;
    $count = 0;
    $payment_methods = array();

    foreach ($orders as $order) {
        $count++;
        $total += (float) $order->get_total();
        $method = $order->get_payment_method_title();
        if (!isset($payment_methods[$method])) {
            $payment_methods[$method] = array('count' => 0, 'total' => 0);
        }
        $payment_methods[$method]['count']++;
        $payment_methods[$method]['total'] += (float) $order->get_total();
    }

    return array(
        'summary' => 'Sales summary returned',
        'data' => array(
            'period' => $period,
            'from' => $from,
            'orderCount' => $count,
            'revenue' => wc_format_decimal($total, wc_get_price_decimals()),
            'averageOrder' => $count > 0 ? wc_format_decimal($total / $count, wc_get_price_decimals()) : '0',
            'byPaymentMethod' => $payment_methods,
        ),
    );
}

function psa_wc_assistant_tool_order_summary($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $orders = wc_get_orders(array(
        'limit' => $limit,
        'orderby' => 'date',
        'order' => 'DESC',
    ));

    $items = array_map(function ($order) {
        return array(
            'id' => $order->get_id(),
            'number' => $order->get_order_number(),
            'status' => $order->get_status(),
            'total' => $order->get_total(),
            'currency' => $order->get_currency(),
            'customer' => trim($order->get_billing_first_name() . ' ' . $order->get_billing_last_name()),
            'dateCreated' => $order->get_date_created() ? $order->get_date_created()->date('c') : null,
            'adminUrl' => admin_url('admin.php?page=wc-orders&action=edit&id=' . $order->get_id()),
        );
    }, $orders);

    return array('summary' => count($items) . ' orders returned', 'data' => array('limit' => $limit, 'orders' => $items));
}

function psa_wc_assistant_tool_product_summary($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $products = wc_get_products(array('limit' => $limit, 'status' => array('publish', 'draft'), 'orderby' => 'date', 'order' => 'DESC'));
    $items = array_map('psa_wc_assistant_product_data', $products);

    return array(
        'summary' => count($items) . ' products returned',
        'data' => array(
            'limit' => $limit,
            'products' => $items,
        ),
    );
}

function psa_wc_assistant_tool_find_products($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $search = isset($args['search']) ? sanitize_text_field($args['search']) : '';
    $products = wc_get_products(array(
        'limit' => $limit,
        'search' => $search,
        'status' => array('publish', 'draft'),
        'orderby' => 'title',
        'order' => 'ASC',
    ));
    $items = array();

    foreach ($products as $product) {
        $items[] = psa_wc_assistant_product_data($product);

        if ($product->is_type('variable')) {
            foreach ($product->get_children() as $variation_id) {
                if (count($items) >= $limit) {
                    break;
                }
                $variation = wc_get_product($variation_id);
                if ($variation) {
                    $items[] = psa_wc_assistant_product_data($variation);
                }
            }
        }
    }

    return array('summary' => count($items) . ' products matched', 'data' => array('search' => $search, 'products' => $items));
}

function psa_wc_assistant_tool_product_categories($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 20, 20, 50);
    $search = isset($args['search']) ? sanitize_text_field($args['search']) : '';
    $terms = get_terms(array(
        'taxonomy' => 'product_cat',
        'hide_empty' => false,
        'search' => $search,
        'number' => $limit,
        'orderby' => 'name',
        'order' => 'ASC',
    ));

    if (is_wp_error($terms)) {
        return $terms;
    }

    $categories = array_values(array_filter(array_map('psa_wc_assistant_category_data', $terms)));
    return array(
        'summary' => count($categories) . ' product categories returned',
        'data' => array('search' => $search, 'categories' => $categories),
    );
}

function psa_wc_assistant_collect_category_price_targets($term, $include_variations, $limit) {
    $products = wc_get_products(array(
        'limit' => $limit + 1,
        'category' => array($term->slug),
        'status' => array('publish', 'draft'),
        'orderby' => 'title',
        'order' => 'ASC',
    ));
    $items = array();
    $truncated = false;

    foreach ($products as $product) {
        if (count($items) >= $limit) {
            $truncated = true;
            break;
        }

        if ($product->is_type('simple')) {
            $items[] = $product;
            continue;
        }

        if ($product->is_type('variable') && $include_variations) {
            foreach ($product->get_children() as $variation_id) {
                if (count($items) >= $limit) {
                    $truncated = true;
                    break 2;
                }
                $variation = wc_get_product($variation_id);
                if ($variation) {
                    $items[] = $variation;
                }
            }
        }
    }

    return array('products' => $items, 'truncated' => $truncated);
}

function psa_wc_assistant_tool_find_products_by_category($args) {
    $term = psa_wc_assistant_resolve_product_category($args);
    if (is_wp_error($term)) {
        return $term;
    }

    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 20, 20, 100);
    $include_variations = !isset($args['includeVariations']) || (bool) $args['includeVariations'];
    $collection = psa_wc_assistant_collect_category_price_targets($term, $include_variations, $limit);
    $products = array_map('psa_wc_assistant_product_data', $collection['products']);

    return array(
        'summary' => count($products) . ' products returned for category ' . $term->name,
        'data' => array(
            'category' => psa_wc_assistant_category_data($term),
            'includeVariations' => $include_variations,
            'limit' => $limit,
            'truncated' => $collection['truncated'],
            'products' => $products,
        ),
    );
}

function psa_wc_assistant_tool_low_stock_products($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $products = wc_get_products(array('limit' => 100, 'status' => array('publish', 'draft'), 'stock_status' => 'instock'));
    $threshold = absint(get_option('woocommerce_notify_low_stock_amount', 2));
    $items = array();

    foreach ($products as $product) {
        if (!$product->managing_stock()) {
            continue;
        }
        $quantity = $product->get_stock_quantity();
        if ($quantity !== null && $quantity <= $threshold) {
            $items[] = psa_wc_assistant_product_data($product);
        }
        if (count($items) >= $limit) {
            break;
        }
    }

    return array('summary' => count($items) . ' low-stock products returned', 'data' => array('threshold' => $threshold, 'products' => $items));
}

function psa_wc_assistant_tool_customer_summary($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $users = get_users(array('role__in' => array('customer'), 'number' => $limit, 'orderby' => 'registered', 'order' => 'DESC'));
    $customers = array_map(function ($user) {
        return array(
            'id' => $user->ID,
            'name' => $user->display_name,
            'email' => $user->user_email,
            'registered' => $user->user_registered,
        );
    }, $users);

    return array('summary' => count($customers) . ' customers returned', 'data' => array('customers' => $customers));
}

function psa_wc_assistant_tool_coupon_summary($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $posts = get_posts(array('post_type' => 'shop_coupon', 'post_status' => 'any', 'numberposts' => $limit, 'orderby' => 'date', 'order' => 'DESC'));
    $coupons = array();

    foreach ($posts as $post) {
        $coupon = new WC_Coupon($post->ID);
        $coupons[] = array(
            'id' => $coupon->get_id(),
            'code' => $coupon->get_code(),
            'amount' => $coupon->get_amount(),
            'discountType' => $coupon->get_discount_type(),
            'usageCount' => $coupon->get_usage_count(),
        );
    }

    return array('summary' => count($coupons) . ' coupons returned', 'data' => array('coupons' => $coupons));
}

function psa_wc_assistant_tool_refund_summary($args) {
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $refunds = wc_get_orders(array('limit' => $limit, 'type' => 'shop_order_refund', 'orderby' => 'date', 'order' => 'DESC'));
    $items = array_map(function ($refund) {
        return array(
            'id' => $refund->get_id(),
            'amount' => $refund->get_amount(),
            'reason' => $refund->get_reason(),
            'dateCreated' => $refund->get_date_created() ? $refund->get_date_created()->date('c') : null,
        );
    }, $refunds);

    return array('summary' => count($items) . ' refunds returned', 'data' => array('refunds' => $items));
}

function psa_wc_assistant_tool_operational_alerts($args) {
    $low_stock = psa_wc_assistant_tool_low_stock_products(array('limit' => 10));
    $orders = wc_get_orders(array('limit' => 10, 'status' => array('failed', 'on-hold'), 'orderby' => 'date', 'order' => 'DESC'));
    $orders_need_attention = array_map(function ($order) {
        return array(
            'id' => $order->get_id(),
            'number' => $order->get_order_number(),
            'status' => $order->get_status(),
            'total' => $order->get_total(),
            'adminUrl' => admin_url('admin.php?page=wc-orders&action=edit&id=' . $order->get_id()),
        );
    }, $orders);

    return array(
        'summary' => 'Operational alerts returned',
        'data' => array(
            'lowStock' => isset($low_stock['data']['products']) ? $low_stock['data']['products'] : array(),
            'ordersNeedAttention' => $orders_need_attention,
        ),
    );
}

function psa_wc_assistant_service_run_url() {
    $service_url = untrailingslashit((string) get_option(PSA_WC_OPTION_SERVICE_URL, ''));
    if ($service_url === '') {
        return '';
    }

    $run_path = '/v1/woocommerce/run';
    if (substr($service_url, -strlen($run_path)) === $run_path) {
        return $service_url;
    }

    return $service_url . $run_path;
}

function psa_wc_assistant_signature_headers($body) {
    $site_id = get_option(PSA_WC_OPTION_SITE_ID, '');
    $secret = get_option(PSA_WC_OPTION_SITE_SECRET, '');
    $timestamp = (string) time();
    $signature = hash_hmac('sha256', $timestamp . '.' . $site_id . '.' . $body, $secret);

    return array(
        'x-oninova-assistant-site' => $site_id,
        'x-oninova-assistant-timestamp' => $timestamp,
        'x-oninova-assistant-signature' => $signature,
    );
}

function psa_wc_assistant_call_service($payload) {
    $service_url = psa_wc_assistant_service_run_url();
    if ($service_url === '') {
        return new WP_Error('assistant_service_missing', 'Assistant service URL is not configured.', array('status' => 400));
    }

    $body = wp_json_encode($payload);
    $response = wp_remote_post($service_url, array(
        'timeout' => 60,
        'headers' => array_merge(array('Content-Type' => 'application/json'), psa_wc_assistant_signature_headers($body)),
        'body' => $body,
    ));

    if (is_wp_error($response)) {
        return $response;
    }

    $status_code = wp_remote_retrieve_response_code($response);
    $decoded = json_decode(wp_remote_retrieve_body($response), true);

    if ($status_code < 200 || $status_code >= 300) {
        $message = is_array($decoded) && isset($decoded['error']) ? $decoded['error'] : 'Assistant service request failed.';
        return new WP_Error('assistant_service_error', $message, array('status' => $status_code));
    }

    return is_array($decoded) ? $decoded : array();
}

function psa_wc_assistant_status_payload() {
    $mode = get_option(PSA_WC_OPTION_MODE, 'direct');
    $has_openai_key = get_option(PSA_WC_OPTION_OPENAI_API_KEY, '') !== '';
    $service_url = psa_wc_assistant_service_run_url();

    return array(
        'enabled' => true,
        'provider' => $mode === 'service' ? 'assistant_service' : 'openai',
        'mode' => $mode,
        'model' => get_option(PSA_WC_OPTION_OPENAI_MODEL, PSA_WC_DEFAULT_OPENAI_MODEL),
        'configured' => $mode === 'service' ? $service_url !== '' : $has_openai_key,
        'hasApiKey' => $has_openai_key,
        'hasServiceUrl' => $service_url !== '',
    );
}

function psa_wc_assistant_unavailable_message() {
    $mode = get_option(PSA_WC_OPTION_MODE, 'direct');
    if ($mode === 'service') {
        return 'AI assistant is installed, but the central assistant service URL is not configured yet. Add it in WooCommerce > AI Assistant, then ask again.';
    }

    return 'AI assistant is installed, but the OpenAI API key is not configured yet. Paste the key in WooCommerce > AI Assistant, save settings, then ask again.';
}

function psa_wc_assistant_tool_names($tool_definitions) {
    $names = array();
    foreach ($tool_definitions as $tool) {
        if (isset($tool['name'])) {
            $names[] = $tool['name'];
        }
    }
    return count($names) ? implode(', ', $names) : 'none';
}

function psa_wc_assistant_format_context($context_documents) {
    if (!is_array($context_documents) || count($context_documents) === 0) {
        return 'No generated Markdown context is available yet. Use approved tools when WooCommerce data is needed.';
    }

    $blocks = array();
    foreach ($context_documents as $document) {
        $content = isset($document['content']) ? (string) $document['content'] : '';
        if (strlen($content) > 4000) {
            $content = substr($content, 0, 4000) . '...';
        }
        $blocks[] = '## ' . $document['title'] . "\nScope: " . $document['scope'] . "\n" . $content;
    }

    return implode("\n\n---\n\n", $blocks);
}

function psa_wc_assistant_format_pages($pages) {
    $lines = array();
    foreach ($pages as $page) {
        $details = array();
        if (!empty($page['description'])) {
            $details[] = $page['description'];
        }
        if (!empty($page['actionTypes'])) {
            $details[] = 'action types: ' . implode(', ', $page['actionTypes']);
        }
        $lines[] = '- ' . $page['id'] . ': ' . $page['label'] . ' -> ' . $page['route'] . (count($details) ? ' (' . implode('; ', $details) . ')' : '');
    }
    return count($lines) ? implode("\n", $lines) : '- fallback -> ' . psa_wc_admin_path('admin.php?page=wc-admin');
}

function psa_wc_assistant_format_write_actions($actions) {
    $lines = array();
    foreach ($actions as $action) {
        $details = array();
        if (!empty($action['description'])) {
            $details[] = $action['description'];
        }
        if (!empty($action['handlerName'])) {
            $details[] = 'handler: ' . $action['handlerName'];
        }
        if (!empty($action['requiredRoles'])) {
            $details[] = 'requires: ' . implode(', ', $action['requiredRoles']);
        }
        if (!empty($action['payloadSchema'])) {
            $details[] = 'payload schema: ' . wp_json_encode($action['payloadSchema']);
        }
        $lines[] = '- ' . $action['type'] . (count($details) ? ' (' . implode('; ', $details) . ')' : '');
    }
    return count($lines) ? implode("\n", $lines) : '- none';
}

function psa_wc_assistant_build_system_prompt($payload) {
    $tool_definitions = isset($payload['toolDefinitions']) ? $payload['toolDefinitions'] : array();
    $page_registry = isset($payload['pageRegistry']) ? $payload['pageRegistry'] : array();
    $write_actions = isset($payload['writeActions']) ? $payload['writeActions'] : array();
    $context_documents = isset($payload['contextDocuments']) ? $payload['contextDocuments'] : array();
    $locale = isset($payload['locale']) ? $payload['locale'] : determine_locale();

    return implode("\n", array(
        'You are a reusable personal business AI assistant embedded in WordPress WooCommerce wp-admin.',
        'Your job is to help store owners understand WooCommerce operations quickly and safely.',
        '',
        'Operating rules:',
        '- Answer in the user language when clear; otherwise match the WordPress locale.',
        '- Be short and straightforward by default: 2-5 concise bullets or short paragraphs.',
        '- Start with the direct answer or recommendation, then add only the most important supporting numbers.',
        '- Use generated Markdown context first for stable store orientation.',
        '- Use approved read-only tools for live WooCommerce numbers, products, orders, and statistics.',
        '- Never invent WooCommerce values. If a number is unavailable, say what should be checked.',
        '- Never claim that you changed product data unless a separate user-approved apply action succeeds.',
        '- Draft actions are suggestions only and always require manual user review.',
        '- Draft action targetRoute must exactly match one registered wp-admin route below. Do not invent routes, query params, record URLs, or external links.',
        '- For one product price edit, propose update_woocommerce_product_price only when productId, currentPrice, priceField, and currency are known from tools/context.',
        '- For itemized bulk product price edits, propose bulk_update_woocommerce_product_prices only when every affected product or variation is explicitly listed with productId, currentPrice, newPrice, currency, and priceField.',
        '- For category-wide product price edits, use get_product_categories and find_products_by_category when useful, then propose bulk_update_woocommerce_category_product_prices with categoryId/categorySlug/categoryName, priceField, operation, currency, reason, includeVariations, and maxItems.',
        '- Category bulk price operations allowed: set_fixed, decrease_percent, increase_percent, set_percent_of_regular_price, clear_sale_price. Use clear_sale_price only for sale_price.',
        '- V1 does not support stock writes, order status writes, customer edits, coupon edits, or sale schedules.',
        '- Do not ask for raw SQL and do not produce SQL for execution.',
        '',
        'Application locale: ' . $locale,
        'Available read-only tools: ' . psa_wc_assistant_tool_names($tool_definitions),
        '',
        'Registered pages for draft action links:',
        psa_wc_assistant_format_pages($page_registry),
        '',
        'Approved write-capable draft actions:',
        psa_wc_assistant_format_write_actions($write_actions),
        '',
        'Generated Markdown business context:',
        psa_wc_assistant_format_context($context_documents),
    ));
}

function psa_wc_assistant_openai_output_schema() {
    return array(
        'type' => 'object',
        'additionalProperties' => false,
        'required' => array('answer', 'citations', 'draftActions'),
        'properties' => array(
            'answer' => array('type' => 'string'),
            'citations' => array(
                'type' => 'array',
                'items' => array(
                    'type' => 'object',
                    'additionalProperties' => false,
                    'required' => array('label', 'scope'),
                    'properties' => array(
                        'label' => array('type' => 'string'),
                        'scope' => array('type' => 'string'),
                    ),
                ),
            ),
            'draftActions' => array(
                'type' => 'array',
                'items' => array(
                    'type' => 'object',
                    'additionalProperties' => true,
                    'required' => array('type', 'title', 'reason', 'targetRoute', 'payload', 'confidence', 'requiresUserReview'),
                    'properties' => array(
                        'type' => array('type' => 'string'),
                        'title' => array('type' => 'string'),
                        'reason' => array('type' => 'string'),
                        'targetRoute' => array('type' => 'string'),
                        'payload' => array('type' => 'object', 'additionalProperties' => true),
                        'confidence' => array('type' => 'number'),
                        'requiresUserReview' => array('type' => 'boolean'),
                    ),
                ),
            ),
        ),
    );
}

function psa_wc_assistant_openai_request($body) {
    $api_key = get_option(PSA_WC_OPTION_OPENAI_API_KEY, '');
    $response = wp_remote_post('https://api.openai.com/v1/responses', array(
        'timeout' => 90,
        'headers' => array(
            'Authorization' => 'Bearer ' . $api_key,
            'Content-Type' => 'application/json',
        ),
        'body' => wp_json_encode($body),
    ));

    if (is_wp_error($response)) {
        return $response;
    }

    $status_code = wp_remote_retrieve_response_code($response);
    $decoded = json_decode(wp_remote_retrieve_body($response), true);
    if ($status_code < 200 || $status_code >= 300) {
        $message = is_array($decoded) && isset($decoded['error']['message'])
            ? $decoded['error']['message']
            : 'OpenAI request failed.';
        return new WP_Error('openai_request_failed', $message, array('status' => $status_code));
    }

    return is_array($decoded) ? $decoded : array();
}

function psa_wc_assistant_extract_output_text($response) {
    if (!empty($response['output_text'])) {
        return (string) $response['output_text'];
    }

    foreach ((array) (isset($response['output']) ? $response['output'] : array()) as $item) {
        if (isset($item['type']) && $item['type'] === 'message') {
            foreach ((array) (isset($item['content']) ? $item['content'] : array()) as $part) {
                if (isset($part['text']) && (empty($part['type']) || in_array($part['type'], array('output_text', 'text'), true))) {
                    return (string) $part['text'];
                }
            }
        }
    }

    return '';
}

function psa_wc_assistant_parse_tool_args($arguments) {
    if (is_array($arguments)) {
        return $arguments;
    }
    $decoded = json_decode((string) $arguments, true);
    return is_array($decoded) ? $decoded : array();
}

function psa_wc_assistant_base_openai_body($instructions, $input_items, $tool_definitions) {
    return array(
        'model' => get_option(PSA_WC_OPTION_OPENAI_MODEL, PSA_WC_DEFAULT_OPENAI_MODEL),
        'instructions' => $instructions,
        'input' => $input_items,
        'tools' => $tool_definitions,
        'tool_choice' => 'auto',
        'parallel_tool_calls' => false,
        'store' => false,
        'include' => array('reasoning.encrypted_content'),
        'max_tool_calls' => 4,
        'reasoning' => array('effort' => 'low'),
        'text' => array(
            'verbosity' => 'low',
            'format' => array(
                'type' => 'json_schema',
                'name' => 'woocommerce_assistant_response',
                'strict' => false,
                'schema' => psa_wc_assistant_openai_output_schema(),
            ),
        ),
    );
}

function psa_wc_assistant_clamp_route($action, $fallback_route) {
    $pages = psa_wc_assistant_page_registry();
    $target_route = isset($action['targetRoute']) ? (string) $action['targetRoute'] : '';
    foreach ($pages as $page) {
        if ($target_route !== '' && $target_route === $page['route']) {
            return $page['route'];
        }
    }

    $type = isset($action['type']) ? sanitize_key($action['type']) : '';
    foreach ($pages as $page) {
        if (!empty($page['actionTypes']) && in_array($type, $page['actionTypes'], true)) {
            return $page['route'];
        }
    }

    return $fallback_route;
}

function psa_wc_assistant_validate_direct_draft_actions($actions, $fallback_route) {
    $allowed = array(
        'open_page',
        'operational_note',
        'review_order',
        'review_report',
        'review_product',
        'review_stock',
        'follow_up_client',
        'review_customer',
        'review_coupon',
        'update_woocommerce_product_price',
        'bulk_update_woocommerce_product_prices',
        'bulk_update_woocommerce_category_product_prices',
    );
    $validated = array();

    foreach (array_slice(is_array($actions) ? $actions : array(), 0, 6) as $action) {
        $title = isset($action['title']) ? sanitize_text_field($action['title']) : '';
        $reason = isset($action['reason']) ? sanitize_textarea_field($action['reason']) : '';
        if ($title === '' || $reason === '') {
            continue;
        }

        $type = isset($action['type']) ? sanitize_key($action['type']) : 'operational_note';
        if (!in_array($type, $allowed, true)) {
            $type = 'operational_note';
        }

        $normalized = array(
            'type' => $type,
            'title' => substr($title, 0, 255),
            'reason' => substr($reason, 0, 2000),
            'targetRoute' => psa_wc_assistant_clamp_route($action, $fallback_route),
            'payload' => isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array(),
            'confidence' => max(0, min(1, isset($action['confidence']) ? (float) $action['confidence'] : 0)),
            'requiresUserReview' => true,
            'status' => 'draft',
        );
        $validated[] = $normalized;
    }

    return $validated;
}

function psa_wc_assistant_call_openai_direct($payload) {
    if (get_option(PSA_WC_OPTION_OPENAI_API_KEY, '') === '') {
        return array(
            'status' => psa_wc_assistant_status_payload(),
            'answer' => psa_wc_assistant_unavailable_message(),
            'citations' => array(),
            'draftActions' => array(),
            'toolRuns' => array(),
        );
    }

    $instructions = psa_wc_assistant_build_system_prompt($payload);
    $tool_definitions = isset($payload['toolDefinitions']) ? $payload['toolDefinitions'] : array();
    $fallback_route = isset($payload['fallbackRoute']) ? $payload['fallbackRoute'] : psa_wc_admin_path('admin.php?page=wc-admin');
    $input_items = array();

    foreach (array_slice((array) (isset($payload['conversationMessages']) ? $payload['conversationMessages'] : array()), -10) as $message) {
        if (!empty($message['content'])) {
            $input_items[] = array(
                'role' => isset($message['role']) && $message['role'] === 'assistant' ? 'assistant' : 'user',
                'content' => (string) $message['content'],
            );
        }
    }
    $input_items[] = array('role' => 'user', 'content' => (string) $payload['message']);

    $tool_runs = array();
    $response = psa_wc_assistant_openai_request(psa_wc_assistant_base_openai_body($instructions, $input_items, $tool_definitions));
    if (is_wp_error($response)) {
        return $response;
    }

    for ($index = 0; $index < 4; $index++) {
        $calls = array();
        foreach ((array) (isset($response['output']) ? $response['output'] : array()) as $item) {
            if (isset($item['type']) && $item['type'] === 'function_call') {
                $calls[] = $item;
            }
        }

        if (count($calls) === 0) {
            break;
        }

        $outputs = array();
        foreach ($calls as $call) {
            $started = microtime(true);
            $tool_name = sanitize_key(isset($call['name']) ? $call['name'] : '');
            $args = psa_wc_assistant_parse_tool_args(isset($call['arguments']) ? $call['arguments'] : array());
            $tool_result = psa_wc_assistant_run_tool_by_name($tool_name, $args);
            $duration_ms = (int) round((microtime(true) - $started) * 1000);

            if (is_wp_error($tool_result)) {
                $tool_runs[] = array(
                    'toolName' => $tool_name,
                    'args' => $args,
                    'resultSummary' => null,
                    'status' => 'failed',
                    'error' => $tool_result->get_error_message(),
                    'durationMs' => $duration_ms,
                );
                $output_data = array('error' => $tool_result->get_error_message());
            } else {
                $tool_runs[] = array(
                    'toolName' => $tool_name,
                    'args' => $args,
                    'resultSummary' => isset($tool_result['summary']) ? $tool_result['summary'] : 'WooCommerce data returned',
                    'status' => 'completed',
                    'durationMs' => $duration_ms,
                );
                $output_data = isset($tool_result['data']) ? $tool_result['data'] : $tool_result;
            }

            $outputs[] = array(
                'type' => 'function_call_output',
                'call_id' => isset($call['call_id']) ? $call['call_id'] : '',
                'output' => wp_json_encode($output_data),
            );
        }

        $input_items = array_merge($input_items, (array) (isset($response['output']) ? $response['output'] : array()), $outputs);
        $response = psa_wc_assistant_openai_request(psa_wc_assistant_base_openai_body($instructions, $input_items, $tool_definitions));
        if (is_wp_error($response)) {
            return $response;
        }
    }

    $text = psa_wc_assistant_extract_output_text($response);
    $parsed = json_decode($text, true);
    if (!is_array($parsed)) {
        $parsed = array('answer' => $text !== '' ? $text : 'I could not produce a structured answer. Please try again.', 'citations' => array(), 'draftActions' => array());
    }

    return array(
        'status' => psa_wc_assistant_status_payload(),
        'answer' => isset($parsed['answer']) ? (string) $parsed['answer'] : '',
        'citations' => isset($parsed['citations']) && is_array($parsed['citations']) ? $parsed['citations'] : array(),
        'draftActions' => psa_wc_assistant_validate_direct_draft_actions(isset($parsed['draftActions']) ? $parsed['draftActions'] : array(), $fallback_route),
        'toolRuns' => $tool_runs,
        'providerResponseId' => isset($response['id']) ? $response['id'] : null,
    );
}

function psa_wc_assistant_call_ai($payload) {
    if (get_option(PSA_WC_OPTION_MODE, 'direct') === 'service') {
        if (psa_wc_assistant_service_run_url() === '') {
            return array(
                'status' => psa_wc_assistant_status_payload(),
                'answer' => psa_wc_assistant_unavailable_message(),
                'citations' => array(),
                'draftActions' => array(),
                'toolRuns' => array(),
            );
        }
        return psa_wc_assistant_call_service($payload);
    }

    return psa_wc_assistant_call_openai_direct($payload);
}

function psa_wc_assistant_verify_service_signature($request) {
    $site_id = $request->get_header('x-oninova-assistant-site');
    $timestamp = $request->get_header('x-oninova-assistant-timestamp');
    $signature = $request->get_header('x-oninova-assistant-signature');
    $expected_site_id = get_option(PSA_WC_OPTION_SITE_ID, '');
    $secret = get_option(PSA_WC_OPTION_SITE_SECRET, '');

    if (!$site_id || !$timestamp || !$signature || !$secret || $site_id !== $expected_site_id) {
        return false;
    }

    if (abs(time() - (int) $timestamp) > 300) {
        return false;
    }

    $expected = hash_hmac('sha256', $timestamp . '.' . $site_id . '.' . $request->get_body(), $secret);
    return hash_equals($expected, $signature);
}

function psa_wc_assistant_can_run_signed_tool($request) {
    return psa_wc_assistant_verify_service_signature($request)
        ? true
        : new WP_Error('invalid_assistant_signature', 'Invalid assistant service signature.', array('status' => 401));
}

function psa_wc_assistant_rest_run_tool($request) {
    $tool_name = sanitize_key($request->get_param('toolName'));
    $args = $request->get_param('args');
    $result = psa_wc_assistant_run_tool_by_name($tool_name, is_array($args) ? $args : array());

    if (is_wp_error($result)) {
        return $result;
    }

    return rest_ensure_response($result);
}

function psa_wc_assistant_site_payload() {
    return array(
        'siteId' => get_option(PSA_WC_OPTION_SITE_ID, ''),
        'url' => home_url('/'),
        'name' => get_bloginfo('name'),
        'currency' => function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : '',
    );
}

function psa_wc_assistant_rest_chat($request) {
    $message = sanitize_textarea_field((string) $request->get_param('message'));
    $conversation_id = absint($request->get_param('conversationId'));
    $locale = sanitize_text_field((string) $request->get_param('locale'));

    if ($message === '') {
        return new WP_Error('message_required', 'Message is required.', array('status' => 400));
    }

    $conversation = psa_wc_assistant_get_or_create_conversation($conversation_id, $message);
    $user_message = psa_wc_assistant_add_message($conversation['id'], 'user', $message, array('locale' => $locale));
    $context_documents = psa_wc_assistant_list_context_documents(true);
    if (count($context_documents) === 0) {
        psa_wc_assistant_refresh_context_documents();
        $context_documents = psa_wc_assistant_list_context_documents(true);
    }

    $history = array_filter(psa_wc_assistant_list_messages($conversation['id'], 12), function ($saved_message) use ($user_message) {
        return (int) $saved_message['id'] !== (int) $user_message['id'];
    });

    $service_response = psa_wc_assistant_call_ai(array(
        'site' => psa_wc_assistant_site_payload(),
        'message' => $message,
        'conversationMessages' => array_values($history),
        'contextDocuments' => $context_documents,
        'toolDefinitions' => psa_wc_assistant_tool_definitions(),
        'pageRegistry' => psa_wc_assistant_page_registry(),
        'fallbackRoute' => psa_wc_admin_path('admin.php?page=wc-admin'),
        'writeActions' => psa_wc_assistant_write_actions(),
        'locale' => $locale ? $locale : determine_locale(),
        'callback' => array(
            'toolsRunUrl' => rest_url(PSA_WC_ASSISTANT_REST_NAMESPACE . '/tools/run'),
            'siteId' => get_option(PSA_WC_OPTION_SITE_ID, ''),
        ),
    ));

    if (is_wp_error($service_response)) {
        return $service_response;
    }

    $answer = isset($service_response['answer']) ? (string) $service_response['answer'] : '';
    $assistant_message = psa_wc_assistant_add_message($conversation['id'], 'assistant', $answer, array(
        'citations' => isset($service_response['citations']) ? $service_response['citations'] : array(),
        'providerResponseId' => isset($service_response['providerResponseId']) ? $service_response['providerResponseId'] : null,
        'status' => isset($service_response['status']) ? $service_response['status'] : array(),
    ));

    foreach ((array) (isset($service_response['toolRuns']) ? $service_response['toolRuns'] : array()) as $tool_run) {
        psa_wc_assistant_add_tool_run($conversation['id'], $assistant_message['id'], $tool_run);
    }

    $draft_actions = psa_wc_assistant_add_draft_actions(
        $conversation['id'],
        $assistant_message['id'],
        isset($service_response['draftActions']) ? $service_response['draftActions'] : array()
    );

    return rest_ensure_response(array(
        'status' => isset($service_response['status']) ? $service_response['status'] : array(),
        'conversation' => $conversation,
        'userMessage' => $user_message,
        'assistantMessage' => $assistant_message,
        'answer' => $answer,
        'citations' => isset($service_response['citations']) ? $service_response['citations'] : array(),
        'draftActions' => $draft_actions,
    ));
}

function psa_wc_assistant_rest_conversations() {
    return rest_ensure_response(array('conversations' => psa_wc_assistant_list_conversations()));
}

function psa_wc_assistant_rest_conversation($request) {
    $conversation = psa_wc_assistant_get_conversation(absint($request['id']));
    if (!$conversation) {
        return new WP_Error('conversation_not_found', 'Conversation not found.', array('status' => 404));
    }

    return rest_ensure_response(array(
        'conversation' => $conversation,
        'messages' => psa_wc_assistant_list_messages($conversation['id']),
    ));
}

function psa_wc_assistant_rest_context() {
    return rest_ensure_response(array(
        'status' => psa_wc_assistant_status_payload(),
        'documents' => psa_wc_assistant_list_context_documents(false),
        'site' => psa_wc_assistant_site_payload(),
    ));
}

function psa_wc_assistant_rest_context_refresh() {
    return rest_ensure_response(array(
        'status' => psa_wc_assistant_status_payload(),
        'documents' => psa_wc_assistant_refresh_context_documents(),
        'site' => psa_wc_assistant_site_payload(),
    ));
}

function psa_wc_assistant_prices_match($current_price, $expected_price) {
    $current = $current_price === '' ? '' : wc_format_decimal($current_price);
    $expected = $expected_price === '' ? '' : wc_format_decimal($expected_price);

    if ($current === '' || $expected === '') {
        return $current === $expected;
    }

    return abs((float) $current - (float) $expected) <= 0.00001;
}

function psa_wc_assistant_prepare_price_update($item, $defaults = array()) {
    $item = is_array($item) ? $item : array();
    $product_id = isset($item['productId']) ? absint($item['productId']) : 0;
    $variation_id = isset($item['variationId']) ? absint($item['variationId']) : 0;
    $price_field = isset($item['priceField']) && $item['priceField'] !== ''
        ? sanitize_key($item['priceField'])
        : sanitize_key(isset($defaults['priceField']) ? $defaults['priceField'] : '');
    $currency = isset($item['currency']) && $item['currency'] !== ''
        ? sanitize_text_field($item['currency'])
        : sanitize_text_field(isset($defaults['currency']) ? $defaults['currency'] : '');

    if (!$product_id || !in_array($price_field, array('regular_price', 'sale_price'), true)) {
        return new WP_Error('invalid_price_action', 'Invalid product price action payload.', array('status' => 400));
    }

    if (!array_key_exists('currentPrice', $item) || !array_key_exists('newPrice', $item)) {
        return new WP_Error('invalid_price_action', 'Price action requires currentPrice and newPrice for every product.', array('status' => 400));
    }

    if ($currency && function_exists('get_woocommerce_currency') && $currency !== get_woocommerce_currency()) {
        return new WP_Error('currency_mismatch', 'Price action currency does not match the store currency.', array('status' => 400));
    }

    if (!current_user_can('manage_woocommerce') || !current_user_can('edit_product', $product_id)) {
        return new WP_Error('price_action_forbidden', 'You are not allowed to update this product price.', array('status' => 403));
    }

    $target_id = $variation_id ? $variation_id : $product_id;
    $product = wc_get_product($target_id);
    if (!$product) {
        return new WP_Error('product_not_found', 'Product or variation not found.', array('status' => 404));
    }

    if ($variation_id && (int) $product->get_parent_id() !== (int) $product_id) {
        return new WP_Error('variation_mismatch', 'Variation does not belong to the supplied product.', array('status' => 400));
    }

    $current_price = $price_field === 'regular_price' ? $product->get_regular_price('edit') : $product->get_sale_price('edit');
    $expected_price = (string) $item['currentPrice'];
    $new_price = wc_format_decimal($item['newPrice']);

    if ($new_price === '' || (float) $new_price <= 0) {
        return new WP_Error('invalid_new_price', 'New price must be greater than 0.', array('status' => 400));
    }

    if (!psa_wc_assistant_prices_match((string) $current_price, $expected_price)) {
        return new WP_Error('stale_price', 'Product price changed since this action was drafted.', array('status' => 409));
    }

    if ($price_field === 'sale_price') {
        $regular_price = $product->get_regular_price('edit');
        if ($regular_price !== '' && (float) $new_price > (float) $regular_price) {
            return new WP_Error('invalid_sale_price', 'Sale price cannot be greater than the regular price.', array('status' => 400));
        }
    }

    return array(
        'product' => $product,
        'result' => array(
            'productId' => $product_id,
            'variationId' => $variation_id ? $variation_id : null,
            'targetId' => $target_id,
            'priceField' => $price_field,
            'oldPrice' => (string) $current_price,
            'newPrice' => (string) $new_price,
            'currency' => function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : $currency,
        ),
    );
}

function psa_wc_assistant_save_prepared_price_update($prepared) {
    $product = $prepared['product'];
    $result = $prepared['result'];

    if ($result['priceField'] === 'sale_price') {
        $product->set_sale_price($result['newPrice']);
    } else {
        $product->set_regular_price($result['newPrice']);
    }

    $product->save();
    return $result;
}

function psa_wc_assistant_apply_price_action($action) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $prepared = psa_wc_assistant_prepare_price_update($payload, array());
    if (is_wp_error($prepared)) {
        return $prepared;
    }

    return psa_wc_assistant_save_prepared_price_update($prepared);
}

function psa_wc_assistant_apply_bulk_price_action($action) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $items = isset($payload['items']) && is_array($payload['items']) ? $payload['items'] : array();
    $count = count($items);

    if ($count < 1 || $count > 50) {
        return new WP_Error('invalid_bulk_price_action', 'Bulk price actions must contain 1 to 50 products.', array('status' => 400));
    }

    $defaults = array(
        'priceField' => isset($payload['priceField']) ? sanitize_key($payload['priceField']) : '',
        'currency' => isset($payload['currency']) ? sanitize_text_field($payload['currency']) : '',
    );
    $seen = array();
    $prepared_updates = array();

    foreach ($items as $item) {
        $prepared = psa_wc_assistant_prepare_price_update($item, $defaults);
        if (is_wp_error($prepared)) {
            return $prepared;
        }

        $key = $prepared['result']['targetId'] . ':' . $prepared['result']['priceField'];
        if (isset($seen[$key])) {
            return new WP_Error('duplicate_price_action_item', 'Bulk price action contains the same product price field more than once.', array('status' => 400));
        }

        $seen[$key] = true;
        $prepared_updates[] = $prepared;
    }

    $results = array();
    foreach ($prepared_updates as $prepared) {
        $results[] = psa_wc_assistant_save_prepared_price_update($prepared);
    }

    return array(
        'updatedCount' => count($results),
        'items' => $results,
        'currency' => function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : $defaults['currency'],
        'reason' => isset($payload['reason']) ? sanitize_textarea_field($payload['reason']) : '',
    );
}

function psa_wc_assistant_calculate_category_price($product, $price_field, $operation, $payload) {
    $decimals = function_exists('wc_get_price_decimals') ? wc_get_price_decimals() : 2;
    $regular_price = $product->get_regular_price('edit');
    $current_price = $price_field === 'regular_price'
        ? $product->get_regular_price('edit')
        : $product->get_sale_price('edit');

    if ($operation === 'clear_sale_price') {
        if ($price_field !== 'sale_price') {
            return new WP_Error('invalid_category_price_operation', 'clear_sale_price can only be used with sale_price.', array('status' => 400));
        }
        return '';
    }

    if ($operation === 'set_fixed') {
        $new_price = isset($payload['newPrice']) ? wc_format_decimal($payload['newPrice'], $decimals) : '';
    } else {
        $percent = isset($payload['percent']) ? (float) $payload['percent'] : 0;
        if ($percent <= 0 || $percent > 100) {
            return new WP_Error('invalid_category_price_percent', 'Percent must be greater than 0 and no more than 100.', array('status' => 400));
        }

        if ($operation === 'set_percent_of_regular_price') {
            if ($price_field !== 'sale_price') {
                return new WP_Error('invalid_category_price_operation', 'set_percent_of_regular_price can only be used with sale_price.', array('status' => 400));
            }
            if ($regular_price === '') {
                return new WP_Error('missing_regular_price', 'Cannot calculate sale price because a product has no regular price.', array('status' => 400));
            }
            $new_price = wc_format_decimal(((float) $regular_price) * ($percent / 100), $decimals);
        } else {
            $base_price = $price_field === 'sale_price' ? $regular_price : $current_price;
            if ($base_price === '') {
                return new WP_Error('missing_base_price', 'Cannot calculate category price because a product has no base price.', array('status' => 400));
            }
            $factor = $operation === 'increase_percent' ? (1 + ($percent / 100)) : (1 - ($percent / 100));
            $new_price = wc_format_decimal(((float) $base_price) * $factor, $decimals);
        }
    }

    if ($new_price === '' || (float) $new_price <= 0) {
        return new WP_Error('invalid_new_price', 'New price must be greater than 0.', array('status' => 400));
    }

    if ($price_field === 'sale_price' && $regular_price !== '' && (float) $new_price > (float) $regular_price) {
        return new WP_Error('invalid_sale_price', 'Sale price cannot be greater than the regular price.', array('status' => 400));
    }

    return (string) $new_price;
}

function psa_wc_assistant_prepare_category_price_update($product, $price_field, $operation, $payload) {
    $edit_product_id = $product->get_parent_id() ? $product->get_parent_id() : $product->get_id();
    if (!current_user_can('manage_woocommerce') || !current_user_can('edit_product', $edit_product_id)) {
        return new WP_Error('price_action_forbidden', 'You are not allowed to update one or more products in this category.', array('status' => 403));
    }

    $old_price = $price_field === 'regular_price'
        ? $product->get_regular_price('edit')
        : $product->get_sale_price('edit');
    $new_price = psa_wc_assistant_calculate_category_price($product, $price_field, $operation, $payload);
    if (is_wp_error($new_price)) {
        return $new_price;
    }

    return array(
        'product' => $product,
        'result' => array(
            'productId' => $product->get_parent_id() ? $product->get_parent_id() : $product->get_id(),
            'variationId' => $product->get_parent_id() ? $product->get_id() : null,
            'targetId' => $product->get_id(),
            'name' => $product->get_name(),
            'priceField' => $price_field,
            'oldPrice' => (string) $old_price,
            'newPrice' => (string) $new_price,
        ),
    );
}

function psa_wc_assistant_apply_category_price_action($action) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $term = psa_wc_assistant_resolve_product_category($payload);
    if (is_wp_error($term)) {
        return $term;
    }

    $price_field = isset($payload['priceField']) ? sanitize_key($payload['priceField']) : '';
    $operation = isset($payload['operation']) ? sanitize_key($payload['operation']) : '';
    $currency = isset($payload['currency']) ? sanitize_text_field($payload['currency']) : '';
    $max_items = psa_wc_assistant_limit(isset($payload['maxItems']) ? $payload['maxItems'] : 100, 100, 100);
    $include_variations = !isset($payload['includeVariations']) || (bool) $payload['includeVariations'];

    if (!in_array($price_field, array('regular_price', 'sale_price'), true)) {
        return new WP_Error('invalid_category_price_field', 'Invalid category price field.', array('status' => 400));
    }

    if (!in_array($operation, array('set_fixed', 'decrease_percent', 'increase_percent', 'set_percent_of_regular_price', 'clear_sale_price'), true)) {
        return new WP_Error('invalid_category_price_operation', 'Invalid category price operation.', array('status' => 400));
    }

    if ($currency && function_exists('get_woocommerce_currency') && $currency !== get_woocommerce_currency()) {
        return new WP_Error('currency_mismatch', 'Price action currency does not match the store currency.', array('status' => 400));
    }

    $collection = psa_wc_assistant_collect_category_price_targets($term, $include_variations, $max_items);
    if ($collection['truncated']) {
        return new WP_Error('category_price_limit_exceeded', 'This category has more products than the allowed bulk update limit. Narrow the category or use a smaller batch.', array('status' => 400));
    }

    if (count($collection['products']) === 0) {
        return new WP_Error('category_has_no_products', 'No supported simple products or variations were found in this category.', array('status' => 404));
    }

    $prepared_updates = array();
    foreach ($collection['products'] as $product) {
        $prepared = psa_wc_assistant_prepare_category_price_update($product, $price_field, $operation, $payload);
        if (is_wp_error($prepared)) {
            return $prepared;
        }
        $prepared_updates[] = $prepared;
    }

    $results = array();
    foreach ($prepared_updates as $prepared) {
        $results[] = psa_wc_assistant_save_prepared_price_update($prepared);
    }

    return array(
        'updatedCount' => count($results),
        'category' => psa_wc_assistant_category_data($term),
        'priceField' => $price_field,
        'operation' => $operation,
        'includeVariations' => $include_variations,
        'currency' => function_exists('get_woocommerce_currency') ? get_woocommerce_currency() : $currency,
        'reason' => isset($payload['reason']) ? sanitize_textarea_field($payload['reason']) : '',
        'items' => $results,
    );
}

function psa_wc_assistant_rest_apply_draft_action($request) {
    $action = psa_wc_assistant_get_draft_action(absint($request['id']));
    if (!$action) {
        return new WP_Error('draft_action_not_found', 'Draft action not found.', array('status' => 404));
    }

    if (!in_array($action['status'], array('draft', 'failed'), true)) {
        return new WP_Error('invalid_draft_action_status', 'Draft action cannot be applied from this status.', array('status' => 409));
    }

    if (!in_array($action['type'], array('update_woocommerce_product_price', 'bulk_update_woocommerce_product_prices', 'bulk_update_woocommerce_category_product_prices'), true)) {
        return new WP_Error('unsupported_write_action', 'Unsupported assistant write action.', array('status' => 400));
    }

    if ($action['type'] === 'bulk_update_woocommerce_category_product_prices') {
        $result = psa_wc_assistant_apply_category_price_action($action);
    } elseif ($action['type'] === 'bulk_update_woocommerce_product_prices') {
        $result = psa_wc_assistant_apply_bulk_price_action($action);
    } else {
        $result = psa_wc_assistant_apply_price_action($action);
    }
    if (is_wp_error($result)) {
        $error_data = $result->get_error_data();
        $error_status = is_array($error_data) && isset($error_data['status']) ? (int) $error_data['status'] : 0;
        if ($error_status !== 403) {
            psa_wc_assistant_update_draft_action_status($action['id'], 'failed', array(
                'failedAt' => psa_wc_assistant_now(),
                'error' => $result->get_error_message(),
            ));
        }
        return $result;
    }

    $saved = psa_wc_assistant_update_draft_action_status($action['id'], 'applied', array(
        'appliedAt' => psa_wc_assistant_now(),
        'appliedBy' => get_current_user_id(),
        'applyResult' => $result,
    ));

    return rest_ensure_response(array('draftAction' => $saved, 'result' => $result));
}

function psa_wc_assistant_rest_reject_draft_action($request) {
    $action = psa_wc_assistant_get_draft_action(absint($request['id']));
    if (!$action) {
        return new WP_Error('draft_action_not_found', 'Draft action not found.', array('status' => 404));
    }

    if (!in_array($action['status'], array('draft', 'failed'), true)) {
        return new WP_Error('invalid_draft_action_status', 'Draft action cannot be rejected from this status.', array('status' => 409));
    }

    $saved = psa_wc_assistant_update_draft_action_status($action['id'], 'rejected', array(
        'rejectedAt' => psa_wc_assistant_now(),
        'rejectedBy' => get_current_user_id(),
    ));

    return rest_ensure_response(array('draftAction' => $saved));
}
