<?php
/**
 * Plugin Name: Oninova Personal Assistant for WooCommerce
 * Description: Adds an approved AI assistant drawer for WooCommerce store operations.
 * Version: 0.2.0
 * Author: Oninova
 * Requires Plugins: woocommerce
 */

if (!defined('ABSPATH')) {
    exit;
}

define('PSA_WC_ASSISTANT_VERSION', '0.2.0');
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

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/capabilities', array(
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'psa_wc_assistant_rest_capabilities',
        'permission_callback' => 'psa_wc_assistant_can_use',
    ));

    register_rest_route(PSA_WC_ASSISTANT_REST_NAMESPACE, '/draft-actions/(?P<id>\d+)/preview', array(
        'methods' => WP_REST_Server::CREATABLE,
        'callback' => 'psa_wc_assistant_rest_preview_draft_action',
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
            'name' => 'get_order_statistics',
            'description' => 'Read-only WooCommerce order statistics with current period totals and optional previous-period comparison.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'period' => array('type' => 'string', 'enum' => array('today', 'week', 'month', 'year', 'all')),
                    'comparePrevious' => array('type' => 'boolean'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_product_performance',
            'description' => 'Read-only WooCommerce product performance ranked by revenue or quantity for a selected period/category.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'period' => array('type' => 'string', 'enum' => array('today', 'week', 'month', 'year', 'all')),
                    'categoryId' => array('type' => 'integer'),
                    'categorySlug' => array('type' => 'string'),
                    'categoryName' => array('type' => 'string'),
                    'sortBy' => array('type' => 'string', 'enum' => array('revenue', 'quantity')),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 50),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'compare_products',
            'description' => 'Read-only comparison of selected WooCommerce products by order quantity, revenue, and average sold price.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'period' => array('type' => 'string', 'enum' => array('today', 'week', 'month', 'year', 'all')),
                    'productIds' => array('type' => 'array', 'items' => array('type' => 'integer')),
                    'productNames' => array('type' => 'array', 'items' => array('type' => 'string')),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'compare_categories',
            'description' => 'Read-only comparison of selected WooCommerce product categories by order quantity and revenue.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'period' => array('type' => 'string', 'enum' => array('today', 'week', 'month', 'year', 'all')),
                    'categoryIds' => array('type' => 'array', 'items' => array('type' => 'integer')),
                    'categorySlugs' => array('type' => 'array', 'items' => array('type' => 'string')),
                    'categoryNames' => array('type' => 'array', 'items' => array('type' => 'string')),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_customer_order_preferences',
            'description' => 'Read-only summary of what customers order most, including top products, top categories, and repeat customer rate.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'period' => array('type' => 'string', 'enum' => array('today', 'week', 'month', 'year', 'all')),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 20),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'function',
            'name' => 'get_marketing_campaign_recommendations',
            'description' => 'Read-only deterministic marketing campaign recommendations based on sales, category, product, and stock statistics.',
            'parameters' => array(
                'type' => 'object',
                'properties' => array(
                    'period' => array('type' => 'string', 'enum' => array('week', 'month', 'year')),
                    'limit' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 10),
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
            'actionTypes' => array(
                'review_product',
                'review_stock',
                'update_woocommerce_product_price',
                'bulk_update_woocommerce_product_prices',
                'bulk_update_woocommerce_category_product_prices',
                'update_woocommerce_product_details',
                'bulk_update_woocommerce_product_details',
                'bulk_update_woocommerce_category_product_details',
                'update_woocommerce_product_inventory',
                'bulk_update_woocommerce_product_inventory',
                'bulk_update_woocommerce_category_product_inventory',
            ),
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

function psa_wc_assistant_normalize_write_action($action) {
    $type = isset($action['type']) ? sanitize_key($action['type']) : '';
    $is_category = strpos($type, 'category') !== false;
    $is_bulk = strpos($type, 'bulk') !== false;
    $action['mode'] = 'write';
    $action['resource'] = strpos($type, 'inventory') !== false ? 'inventory' : 'product';
    $action['scope'] = $is_category ? 'category' : ($is_bulk ? 'selection' : 'single');
    $action['risk'] = $is_bulk ? 'high' : 'medium';
    $action['requiresReview'] = true;
    $action['supportsPreview'] = true;
    $action['maxBatchSize'] = $is_category ? 100 : ($is_bulk ? 50 : 1);
    return $action;
}

function psa_wc_assistant_product_detail_fields_schema() {
    return array(
        'type' => 'object',
        'properties' => array(
            'name' => array('type' => 'string'),
            'sku' => array('type' => 'string'),
            'shortDescription' => array('type' => 'string'),
            'description' => array('type' => 'string'),
            'status' => array('type' => 'string', 'enum' => array('publish', 'draft', 'pending', 'private')),
            'featured' => array('type' => 'boolean'),
            'catalogVisibility' => array('type' => 'string', 'enum' => array('visible', 'catalog', 'search', 'hidden')),
            'categoryIds' => array('type' => 'array', 'items' => array('type' => 'integer')),
            'tagIds' => array('type' => 'array', 'items' => array('type' => 'integer')),
            'weight' => array('type' => 'string'),
            'length' => array('type' => 'string'),
            'width' => array('type' => 'string'),
            'height' => array('type' => 'string'),
            'taxStatus' => array('type' => 'string', 'enum' => array('taxable', 'shipping', 'none')),
            'taxClass' => array('type' => 'string'),
            'purchaseNote' => array('type' => 'string'),
            'menuOrder' => array('type' => 'integer'),
            'virtual' => array('type' => 'boolean'),
        ),
        'additionalProperties' => false,
    );
}

function psa_wc_assistant_inventory_fields_schema() {
    return array(
        'type' => 'object',
        'properties' => array(
            'manageStock' => array('type' => 'boolean'),
            'stockQuantity' => array('type' => 'integer', 'minimum' => 0),
            'stockStatus' => array('type' => 'string', 'enum' => array('instock', 'outofstock', 'onbackorder')),
            'backorders' => array('type' => 'string', 'enum' => array('no', 'notify', 'yes')),
            'lowStockAmount' => array('type' => array('number', 'string', 'null')),
        ),
        'additionalProperties' => false,
    );
}

function psa_wc_assistant_write_actions() {
    $actions = array(
        array(
            'type' => 'update_woocommerce_product_price',
            'handlerName' => 'update_woocommerce_product_price',
            'title' => 'Update WooCommerce product price',
            'description' => 'Set, increase, decrease, or clear one simple product/variation regular or sale price after preview and approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('productId', 'variationId', 'priceField', 'currentPrice', 'operation', 'currency', 'reason'),
                'properties' => array(
                    'productId' => array('type' => 'integer'),
                    'variationId' => array('type' => array('integer', 'null')),
                    'priceField' => array('type' => 'string', 'enum' => array('regular_price', 'sale_price')),
                    'currentPrice' => array('type' => 'string'),
                    'newPrice' => array('type' => 'string'),
                    'amount' => array('type' => 'number'),
                    'percent' => array('type' => 'number'),
                    'operation' => array('type' => 'string', 'enum' => array('set', 'increase_percent', 'decrease_percent', 'increase_fixed', 'decrease_fixed', 'set_percent_of_regular_price', 'clear')),
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
            'description' => 'Set, increase, decrease, or clear regular/sale prices for a bounded product or variation list after preview and approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('items', 'currency', 'reason'),
                'properties' => array(
                    'priceField' => array('type' => 'string', 'enum' => array('regular_price', 'sale_price')),
                    'operation' => array('type' => 'string', 'enum' => array('set', 'increase_percent', 'decrease_percent', 'increase_fixed', 'decrease_fixed', 'set_percent_of_regular_price', 'clear')),
                    'newPrice' => array('type' => 'string'),
                    'amount' => array('type' => 'number'),
                    'percent' => array('type' => 'number'),
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
                                'amount' => array('type' => 'number'),
                                'percent' => array('type' => 'number'),
                                'operation' => array('type' => 'string', 'enum' => array('set', 'increase_percent', 'decrease_percent', 'increase_fixed', 'decrease_fixed', 'set_percent_of_regular_price', 'clear')),
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
            'description' => 'Update regular_price or sale_price for all simple products/variations in a WooCommerce product category after WooCommerce manager approval. This category action does not require every product id to be listed.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('priceField', 'operation', 'currency', 'reason'),
                'properties' => array(
                    'categoryId' => array('type' => 'integer'),
                    'categorySlug' => array('type' => 'string'),
                    'categoryName' => array('type' => 'string'),
                    'priceField' => array('type' => 'string', 'enum' => array('regular_price', 'sale_price')),
                    'operation' => array('type' => 'string', 'enum' => array('set', 'set_fixed', 'decrease_percent', 'increase_percent', 'increase_fixed', 'decrease_fixed', 'set_percent_of_regular_price', 'clear', 'clear_sale_price')),
                    'newPrice' => array('type' => 'string'),
                    'percent' => array('type' => 'number'),
                    'amount' => array('type' => 'number'),
                    'includeVariations' => array('type' => 'boolean'),
                    'maxItems' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 100),
                    'currency' => array('type' => 'string'),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'update_woocommerce_product_details',
            'handlerName' => 'update_woocommerce_product_details',
            'title' => 'Update WooCommerce product details',
            'description' => 'Update approved product detail fields after WooCommerce manager approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('productId', 'fields', 'reason'),
                'properties' => array(
                    'productId' => array('type' => 'integer'),
                    'variationId' => array('type' => array('integer', 'null')),
                    'fields' => psa_wc_assistant_product_detail_fields_schema(),
                    'currentValues' => array('type' => 'object', 'additionalProperties' => true),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'bulk_update_woocommerce_product_details',
            'handlerName' => 'bulk_update_woocommerce_product_details',
            'title' => 'Bulk update WooCommerce product details',
            'description' => 'Update approved product detail fields for an explicit list of products after WooCommerce manager approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('items', 'reason'),
                'properties' => array(
                    'items' => array('type' => 'array', 'minItems' => 1, 'maxItems' => 50),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'bulk_update_woocommerce_category_product_details',
            'handlerName' => 'bulk_update_woocommerce_category_product_details',
            'title' => 'Bulk update WooCommerce category product details',
            'description' => 'Update approved product detail fields for all supported products in one category after WooCommerce manager approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('fields', 'reason'),
                'properties' => array(
                    'categoryId' => array('type' => 'integer'),
                    'categorySlug' => array('type' => 'string'),
                    'categoryName' => array('type' => 'string'),
                    'fields' => psa_wc_assistant_product_detail_fields_schema(),
                    'includeVariations' => array('type' => 'boolean'),
                    'maxItems' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 100),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'update_woocommerce_product_inventory',
            'handlerName' => 'update_woocommerce_product_inventory',
            'title' => 'Update WooCommerce product inventory',
            'description' => 'Update approved stock fields for one simple product or variation after preview and approval.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('productId', 'fields', 'reason'),
                'properties' => array(
                    'productId' => array('type' => 'integer'),
                    'variationId' => array('type' => array('integer', 'null')),
                    'fields' => psa_wc_assistant_inventory_fields_schema(),
                    'currentValues' => array('type' => 'object', 'additionalProperties' => true),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'bulk_update_woocommerce_product_inventory',
            'handlerName' => 'bulk_update_woocommerce_product_inventory',
            'title' => 'Bulk update WooCommerce product inventory',
            'description' => 'Update approved stock fields for an explicit list of up to 50 products or variations.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('items', 'reason'),
                'properties' => array(
                    'items' => array('type' => 'array', 'minItems' => 1, 'maxItems' => 50),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
        array(
            'type' => 'bulk_update_woocommerce_category_product_inventory',
            'handlerName' => 'bulk_update_woocommerce_category_product_inventory',
            'title' => 'Bulk update WooCommerce category inventory',
            'description' => 'Update approved stock fields for all supported products or variations in one category.',
            'requiredRoles' => array('manage_woocommerce'),
            'payloadSchema' => array(
                'type' => 'object',
                'required' => array('fields', 'maxItems', 'reason'),
                'properties' => array(
                    'categoryId' => array('type' => 'integer'),
                    'categorySlug' => array('type' => 'string'),
                    'categoryName' => array('type' => 'string'),
                    'fields' => psa_wc_assistant_inventory_fields_schema(),
                    'includeVariations' => array('type' => 'boolean'),
                    'maxItems' => array('type' => 'integer', 'minimum' => 1, 'maximum' => 100),
                    'reason' => array('type' => 'string'),
                ),
                'additionalProperties' => false,
            ),
        ),
    );

    return array_map('psa_wc_assistant_normalize_write_action', $actions);
}

function psa_wc_assistant_write_action_definition($type) {
    foreach (psa_wc_assistant_write_actions() as $definition) {
        if (isset($definition['type']) && $definition['type'] === $type) {
            return $definition;
        }
    }
    return null;
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
    $preferences = psa_wc_assistant_run_tool_by_name('get_customer_order_preferences', array('period' => 'month', 'limit' => 10));
    $campaigns = psa_wc_assistant_run_tool_by_name('get_marketing_campaign_recommendations', array('period' => 'month', 'limit' => 5));

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
        array(
            'scope' => 'customer_preferences_and_marketing',
            'title' => 'Customer Preferences And Marketing Ideas',
            'content' => "# Customer Preferences And Marketing Ideas\n\n## Preferences\n" . psa_wc_assistant_markdown_kv($preferences['data']) . "\n\n## Campaign Ideas\n" . psa_wc_assistant_markdown_list($campaigns['data']['recommendations']),
            'metadata' => array('tools' => array('get_customer_order_preferences', 'get_marketing_campaign_recommendations')),
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
        $type = sanitize_key(isset($action['type']) ? $action['type'] : 'operational_note');
        $definition = psa_wc_assistant_write_action_definition($type);
        $metadata = isset($action['metadata']) && is_array($action['metadata']) ? $action['metadata'] : array();
        if ($definition) {
            $metadata['capability'] = $definition;
        }
        $wpdb->insert($table, array(
            'conversation_id' => $conversation_id,
            'message_id' => $message_id,
            'type' => $type,
            'title' => sanitize_text_field(isset($action['title']) ? $action['title'] : ''),
            'reason' => sanitize_textarea_field(isset($action['reason']) ? $action['reason'] : ''),
            'target_route' => esc_url_raw(isset($action['targetRoute']) ? $action['targetRoute'] : ''),
            'payload' => psa_wc_json_encode(isset($action['payload']) ? $action['payload'] : array()),
            'confidence' => isset($action['confidence']) ? (float) $action['confidence'] : 0,
            'requires_user_review' => 1,
            'status' => 'draft',
            'metadata' => psa_wc_json_encode($metadata),
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
        case 'get_order_statistics':
            return psa_wc_assistant_tool_order_statistics($args);
        case 'get_product_performance':
            return psa_wc_assistant_tool_product_performance($args);
        case 'compare_products':
            return psa_wc_assistant_tool_compare_products($args);
        case 'compare_categories':
            return psa_wc_assistant_tool_compare_categories($args);
        case 'get_customer_order_preferences':
            return psa_wc_assistant_tool_customer_order_preferences($args);
        case 'get_marketing_campaign_recommendations':
            return psa_wc_assistant_tool_marketing_recommendations($args);
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

function psa_wc_assistant_period_bounds($period = 'month') {
    $period = in_array($period, array('today', 'week', 'month', 'year', 'all'), true) ? $period : 'month';
    $end = time();
    $start = strtotime(psa_wc_assistant_period_start($period));
    if ($period === 'all') {
        $start = strtotime('2020-01-01 00:00:00');
    }

    $duration = max(1, $end - $start);
    return array(
        'period' => $period,
        'start' => gmdate('Y-m-d H:i:s', $start),
        'end' => gmdate('Y-m-d H:i:s', $end),
        'previousStart' => gmdate('Y-m-d H:i:s', $start - $duration),
        'previousEnd' => gmdate('Y-m-d H:i:s', $start),
    );
}

function psa_wc_assistant_orders_for_bounds($start, $end, $limit = 250) {
    $args = array(
        'limit' => $limit,
        'status' => array('processing', 'completed'),
        'orderby' => 'date',
        'order' => 'DESC',
    );

    if ($start && $end) {
        $args['date_created'] = $start . '...' . $end;
    }

    return wc_get_orders($args);
}

function psa_wc_assistant_empty_product_stat($product) {
    $data = psa_wc_assistant_product_data($product);
    return array(
        'productId' => $product ? $product->get_id() : null,
        'parentId' => $data ? $data['parentId'] : null,
        'name' => $data ? $data['name'] : '',
        'sku' => $data ? $data['sku'] : '',
        'quantity' => 0,
        'revenue' => 0,
        'orders' => 0,
        'averageSoldPrice' => 0,
        'currentRegularPrice' => $data ? $data['regularPrice'] : '',
        'currentSalePrice' => $data ? $data['salePrice'] : '',
    );
}

function psa_wc_assistant_order_analytics($orders) {
    $product_stats = array();
    $category_stats = array();
    $customer_orders = array();
    $order_count = 0;
    $revenue = 0;

    foreach ($orders as $order) {
        $order_count++;
        $revenue += (float) $order->get_total();
        $customer_key = $order->get_customer_id() ? 'user:' . $order->get_customer_id() : 'email:' . strtolower((string) $order->get_billing_email());
        if (!isset($customer_orders[$customer_key])) {
            $customer_orders[$customer_key] = 0;
        }
        $customer_orders[$customer_key]++;

        foreach ($order->get_items() as $item) {
            $product = $item->get_product();
            if (!$product) {
                continue;
            }

            $target_id = $product->get_id();
            if (!isset($product_stats[$target_id])) {
                $product_stats[$target_id] = psa_wc_assistant_empty_product_stat($product);
            }
            $quantity = (float) $item->get_quantity();
            $line_total = (float) $item->get_total();
            $product_stats[$target_id]['quantity'] += $quantity;
            $product_stats[$target_id]['revenue'] += $line_total;
            $product_stats[$target_id]['orders']++;
            $product_stats[$target_id]['averageSoldPrice'] = $product_stats[$target_id]['quantity'] > 0
                ? $product_stats[$target_id]['revenue'] / $product_stats[$target_id]['quantity']
                : 0;

            $category_product_id = $product->get_parent_id() ? $product->get_parent_id() : $product->get_id();
            $terms = wp_get_post_terms($category_product_id, 'product_cat');
            if (is_wp_error($terms)) {
                continue;
            }
            foreach ($terms as $term) {
                $category_id = (int) $term->term_id;
                if (!isset($category_stats[$category_id])) {
                    $category_stats[$category_id] = array(
                        'categoryId' => $category_id,
                        'name' => $term->name,
                        'slug' => $term->slug,
                        'quantity' => 0,
                        'revenue' => 0,
                        'orders' => 0,
                    );
                }
                $category_stats[$category_id]['quantity'] += $quantity;
                $category_stats[$category_id]['revenue'] += $line_total;
                $category_stats[$category_id]['orders']++;
            }
        }
    }

    $repeat_customers = 0;
    foreach ($customer_orders as $count) {
        if ($count > 1) {
            $repeat_customers++;
        }
    }

    return array(
        'orderCount' => $order_count,
        'revenue' => $revenue,
        'averageOrderValue' => $order_count > 0 ? $revenue / $order_count : 0,
        'uniqueCustomers' => count($customer_orders),
        'repeatCustomers' => $repeat_customers,
        'repeatCustomerRate' => count($customer_orders) > 0 ? $repeat_customers / count($customer_orders) : 0,
        'products' => array_values($product_stats),
        'categories' => array_values($category_stats),
    );
}

function psa_wc_assistant_sort_stats($rows, $sort_by = 'revenue') {
    $key = $sort_by === 'quantity' ? 'quantity' : 'revenue';
    usort($rows, function ($a, $b) use ($key) {
        return ($b[$key] ?? 0) <=> ($a[$key] ?? 0);
    });
    return $rows;
}

function psa_wc_assistant_round_money_rows($rows) {
    return array_map(function ($row) {
        foreach (array('revenue', 'averageSoldPrice', 'averageOrderValue') as $key) {
            if (isset($row[$key])) {
                $row[$key] = wc_format_decimal($row[$key], wc_get_price_decimals());
            }
        }
        return $row;
    }, $rows);
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

function psa_wc_assistant_tool_order_statistics($args) {
    $period = isset($args['period']) ? sanitize_key($args['period']) : 'month';
    $bounds = psa_wc_assistant_period_bounds($period);
    $orders = psa_wc_assistant_orders_for_bounds($bounds['start'], $bounds['end']);
    $analytics = psa_wc_assistant_order_analytics($orders);
    $data = array(
        'period' => $period,
        'from' => $bounds['start'],
        'to' => $bounds['end'],
        'orderCount' => $analytics['orderCount'],
        'revenue' => wc_format_decimal($analytics['revenue'], wc_get_price_decimals()),
        'averageOrderValue' => wc_format_decimal($analytics['averageOrderValue'], wc_get_price_decimals()),
        'uniqueCustomers' => $analytics['uniqueCustomers'],
        'repeatCustomers' => $analytics['repeatCustomers'],
        'repeatCustomerRate' => round($analytics['repeatCustomerRate'], 4),
    );

    if (!empty($args['comparePrevious']) && $period !== 'all') {
        $previous_orders = psa_wc_assistant_orders_for_bounds($bounds['previousStart'], $bounds['previousEnd']);
        $previous = psa_wc_assistant_order_analytics($previous_orders);
        $previous_revenue = (float) $previous['revenue'];
        $data['previousPeriod'] = array(
            'from' => $bounds['previousStart'],
            'to' => $bounds['previousEnd'],
            'orderCount' => $previous['orderCount'],
            'revenue' => wc_format_decimal($previous_revenue, wc_get_price_decimals()),
            'revenueChangePercent' => $previous_revenue > 0 ? round((($analytics['revenue'] - $previous_revenue) / $previous_revenue) * 100, 2) : null,
            'orderChange' => $analytics['orderCount'] - $previous['orderCount'],
        );
    }

    return array('summary' => 'Order statistics returned', 'data' => $data);
}

function psa_wc_assistant_tool_product_performance($args) {
    $period = isset($args['period']) ? sanitize_key($args['period']) : 'month';
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 50);
    $sort_by = isset($args['sortBy']) && $args['sortBy'] === 'quantity' ? 'quantity' : 'revenue';
    $bounds = psa_wc_assistant_period_bounds($period);
    $analytics = psa_wc_assistant_order_analytics(psa_wc_assistant_orders_for_bounds($bounds['start'], $bounds['end']));
    $products = $analytics['products'];
    $category = null;

    if (!empty($args['categoryId']) || !empty($args['categorySlug']) || !empty($args['categoryName'])) {
        $term = psa_wc_assistant_resolve_product_category($args);
        if (is_wp_error($term)) {
            return $term;
        }
        $category = psa_wc_assistant_category_data($term);
        $collection = psa_wc_assistant_collect_category_price_targets($term, true, 200);
        $allowed = array_fill_keys(array_map(function ($product) {
            return $product->get_id();
        }, $collection['products']), true);
        $products = array_values(array_filter($products, function ($row) use ($allowed) {
            return isset($allowed[$row['productId']]);
        }));
    }

    $products = array_slice(psa_wc_assistant_sort_stats($products, $sort_by), 0, $limit);
    return array(
        'summary' => count($products) . ' product performance rows returned',
        'data' => array(
            'period' => $period,
            'sortBy' => $sort_by,
            'category' => $category,
            'products' => psa_wc_assistant_round_money_rows($products),
        ),
    );
}

function psa_wc_assistant_resolve_product_ids_for_compare($args, $limit) {
    $ids = array();
    foreach ((array) (isset($args['productIds']) ? $args['productIds'] : array()) as $id) {
        $id = absint($id);
        if ($id) {
            $ids[$id] = true;
        }
    }

    foreach ((array) (isset($args['productNames']) ? $args['productNames'] : array()) as $name) {
        $products = wc_get_products(array(
            'limit' => 5,
            'search' => sanitize_text_field($name),
            'status' => array('publish', 'draft'),
        ));
        foreach ($products as $product) {
            $ids[$product->get_id()] = true;
            if ($product->is_type('variable')) {
                foreach ($product->get_children() as $variation_id) {
                    $ids[(int) $variation_id] = true;
                }
            }
            if (count($ids) >= $limit) {
                break 2;
            }
        }
    }

    return array_slice(array_keys($ids), 0, $limit);
}

function psa_wc_assistant_tool_compare_products($args) {
    $period = isset($args['period']) ? sanitize_key($args['period']) : 'month';
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $ids = psa_wc_assistant_resolve_product_ids_for_compare($args, $limit);
    if (count($ids) === 0) {
        return new WP_Error('products_required', 'Provide productIds or productNames to compare products.', array('status' => 400));
    }

    $bounds = psa_wc_assistant_period_bounds($period);
    $analytics = psa_wc_assistant_order_analytics(psa_wc_assistant_orders_for_bounds($bounds['start'], $bounds['end']));
    $by_id = array();
    foreach ($analytics['products'] as $row) {
        $by_id[$row['productId']] = $row;
    }

    $rows = array();
    foreach ($ids as $id) {
        if (isset($by_id[$id])) {
            $rows[] = $by_id[$id];
            continue;
        }
        $product = wc_get_product($id);
        if ($product) {
            $rows[] = psa_wc_assistant_empty_product_stat($product);
        }
    }

    return array(
        'summary' => count($rows) . ' products compared',
        'data' => array('period' => $period, 'products' => psa_wc_assistant_round_money_rows($rows)),
    );
}

function psa_wc_assistant_resolve_categories_for_compare($args, $limit) {
    $terms = array();
    foreach ((array) (isset($args['categoryIds']) ? $args['categoryIds'] : array()) as $id) {
        $term = get_term(absint($id), 'product_cat');
        if ($term && !is_wp_error($term)) {
            $terms[$term->term_id] = $term;
        }
    }
    foreach ((array) (isset($args['categorySlugs']) ? $args['categorySlugs'] : array()) as $slug) {
        $term = get_term_by('slug', sanitize_title($slug), 'product_cat');
        if ($term && !is_wp_error($term)) {
            $terms[$term->term_id] = $term;
        }
    }
    foreach ((array) (isset($args['categoryNames']) ? $args['categoryNames'] : array()) as $name) {
        $term = psa_wc_assistant_resolve_product_category(array('categoryName' => $name));
        if ($term && !is_wp_error($term)) {
            $terms[$term->term_id] = $term;
        }
    }
    return array_slice(array_values($terms), 0, $limit);
}

function psa_wc_assistant_tool_compare_categories($args) {
    $period = isset($args['period']) ? sanitize_key($args['period']) : 'month';
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $terms = psa_wc_assistant_resolve_categories_for_compare($args, $limit);
    if (count($terms) === 0) {
        return new WP_Error('categories_required', 'Provide categoryIds, categorySlugs, or categoryNames to compare categories.', array('status' => 400));
    }

    $bounds = psa_wc_assistant_period_bounds($period);
    $analytics = psa_wc_assistant_order_analytics(psa_wc_assistant_orders_for_bounds($bounds['start'], $bounds['end']));
    $by_id = array();
    foreach ($analytics['categories'] as $row) {
        $by_id[$row['categoryId']] = $row;
    }

    $rows = array();
    foreach ($terms as $term) {
        $rows[] = isset($by_id[$term->term_id])
            ? $by_id[$term->term_id]
            : array('categoryId' => (int) $term->term_id, 'name' => $term->name, 'slug' => $term->slug, 'quantity' => 0, 'revenue' => 0, 'orders' => 0);
    }

    return array(
        'summary' => count($rows) . ' categories compared',
        'data' => array('period' => $period, 'categories' => psa_wc_assistant_round_money_rows($rows)),
    );
}

function psa_wc_assistant_tool_customer_order_preferences($args) {
    $period = isset($args['period']) ? sanitize_key($args['period']) : 'month';
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 10, 10, 20);
    $bounds = psa_wc_assistant_period_bounds($period);
    $analytics = psa_wc_assistant_order_analytics(psa_wc_assistant_orders_for_bounds($bounds['start'], $bounds['end']));
    $top_products = array_slice(psa_wc_assistant_sort_stats($analytics['products'], 'quantity'), 0, $limit);
    $top_categories = array_slice(psa_wc_assistant_sort_stats($analytics['categories'], 'quantity'), 0, $limit);

    return array(
        'summary' => 'Customer order preferences returned',
        'data' => array(
            'period' => $period,
            'orderCount' => $analytics['orderCount'],
            'uniqueCustomers' => $analytics['uniqueCustomers'],
            'repeatCustomerRate' => round($analytics['repeatCustomerRate'], 4),
            'topProducts' => psa_wc_assistant_round_money_rows($top_products),
            'topCategories' => psa_wc_assistant_round_money_rows($top_categories),
        ),
    );
}

function psa_wc_assistant_tool_marketing_recommendations($args) {
    $period = isset($args['period']) ? sanitize_key($args['period']) : 'month';
    if (!in_array($period, array('week', 'month', 'year'), true)) {
        $period = 'month';
    }
    $limit = psa_wc_assistant_limit(isset($args['limit']) ? $args['limit'] : 5, 5, 10);
    $preferences = psa_wc_assistant_tool_customer_order_preferences(array('period' => $period, 'limit' => $limit));
    $low_stock = psa_wc_assistant_tool_low_stock_products(array('limit' => $limit));
    $top_products = isset($preferences['data']['topProducts']) ? $preferences['data']['topProducts'] : array();
    $top_categories = isset($preferences['data']['topCategories']) ? $preferences['data']['topCategories'] : array();
    $recommendations = array();

    if (!empty($top_products[0])) {
        $recommendations[] = array(
            'type' => 'bestseller_campaign',
            'title' => 'Promote the current bestseller',
            'reason' => $top_products[0]['name'] . ' has the highest order quantity in the selected period.',
            'target' => $top_products[0],
            'suggestedOffer' => 'Feature it in email/social ads and bundle it with a related product.',
        );
    }

    if (!empty($top_categories[0])) {
        $recommendations[] = array(
            'type' => 'category_campaign',
            'title' => 'Run a category-focused campaign',
            'reason' => $top_categories[0]['name'] . ' is the strongest category by quantity ordered.',
            'target' => $top_categories[0],
            'suggestedOffer' => 'Create a limited-time category banner, coupon, or collection page.',
        );
    }

    if (!empty($low_stock['data']['products'])) {
        $recommendations[] = array(
            'type' => 'stock_safe_campaign',
            'title' => 'Avoid promoting low-stock products',
            'reason' => 'Some products are low stock and should be excluded from paid campaigns until replenished.',
            'target' => array_slice($low_stock['data']['products'], 0, 3),
            'suggestedOffer' => 'Shift promotion toward available alternatives.',
        );
    }

    if (($preferences['data']['repeatCustomerRate'] ?? 0) > 0.2) {
        $recommendations[] = array(
            'type' => 'loyalty_campaign',
            'title' => 'Reward repeat customers',
            'reason' => 'Repeat customer rate is meaningful for the selected period.',
            'target' => array('repeatCustomerRate' => $preferences['data']['repeatCustomerRate']),
            'suggestedOffer' => 'Send a returning-customer coupon or early access offer.',
        );
    }

    return array(
        'summary' => count($recommendations) . ' marketing recommendations returned',
        'data' => array('period' => $period, 'recommendations' => array_slice($recommendations, 0, $limit)),
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
        foreach (array('resource', 'scope', 'risk') as $field) {
            if (!empty($action[$field])) {
                $details[] = $field . ': ' . $action[$field];
            }
        }
        if (!empty($action['maxBatchSize'])) {
            $details[] = 'maximum records: ' . (int) $action['maxBatchSize'];
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
        $details[] = 'requires explicit review and supports a server-generated preview';
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
        '- Structure business answers for scanning: use short headings only when helpful, bullets for key points, and small tables for comparisons.',
        '- Use generated Markdown context first for stable store orientation.',
        '- Use approved read-only tools for live WooCommerce numbers, products, orders, and statistics.',
        '- Never invent WooCommerce values. If a number is unavailable, say what should be checked.',
        '- When the user asks for statistics, orders, products, categories, comparisons, trends, or performance and numeric data is available, include up to two compact charts in charts[]. Use only tool/context numbers; otherwise return charts: [].',
        '- Never claim that you changed product data unless a separate user-approved apply action succeeds.',
        '- Draft actions are suggestions only. A fresh server preview and manual user review are required before every write.',
        '- Draft action targetRoute must exactly match one registered wp-admin route below. Do not invent routes, query params, record URLs, or external links.',
        '- For one product price edit, propose update_woocommerce_product_price only when productId, currentPrice, priceField, operation, and currency are known from tools/context.',
        '- For itemized bulk product price edits, propose bulk_update_woocommerce_product_prices only when every affected product or variation is explicitly listed with productId, currentPrice, operation, currency, and priceField.',
        '- For category-wide product price edits, do not ask for individual product IDs when a category is named. Use get_product_categories and find_products_by_category when useful, then propose bulk_update_woocommerce_category_product_prices with categoryId/categorySlug/categoryName, priceField, operation, currency, reason, includeVariations, and maxItems.',
        '- Price operations may set, increase, decrease, set a sale percentage of regular price, or clear sale prices when the registered schema allows it.',
        '- For product detail edits, use only fields exposed in the registered schema, including approved catalog text/status, categories/tags, measurements, tax settings, menu order, and virtual status.',
        '- For inventory edits, use only the registered single, explicit-bulk, or category inventory actions and approved fields: manageStock, stockQuantity, stockStatus, backorders, lowStockAmount.',
        '- Never propose order status writes, customer edits, coupon edits, destructive product deletion, or sale schedules.',
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
        'required' => array('answer', 'citations', 'draftActions', 'charts'),
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
            'charts' => array(
                'type' => 'array',
                'maxItems' => 2,
                'items' => array(
                    'type' => 'object',
                    'additionalProperties' => false,
                    'required' => array('type', 'title', 'labels', 'datasets'),
                    'properties' => array(
                        'type' => array('type' => 'string', 'enum' => array('bar', 'line', 'donut')),
                        'title' => array('type' => 'string'),
                        'description' => array('type' => 'string'),
                        'unit' => array('type' => 'string'),
                        'labels' => array(
                            'type' => 'array',
                            'maxItems' => 12,
                            'items' => array('type' => 'string'),
                        ),
                        'datasets' => array(
                            'type' => 'array',
                            'maxItems' => 4,
                            'items' => array(
                                'type' => 'object',
                                'additionalProperties' => false,
                                'required' => array('label', 'data'),
                                'properties' => array(
                                    'label' => array('type' => 'string'),
                                    'data' => array(
                                        'type' => 'array',
                                        'maxItems' => 12,
                                        'items' => array('type' => 'number'),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        ),
    );
}

function psa_wc_assistant_validate_charts($charts) {
    $validated = array();
    $allowed_types = array('bar', 'line', 'donut');

    foreach (array_slice(is_array($charts) ? $charts : array(), 0, 2) as $chart) {
        if (!is_array($chart)) {
            continue;
        }

        $labels = array();
        foreach (array_slice(isset($chart['labels']) && is_array($chart['labels']) ? $chart['labels'] : array(), 0, 12) as $label) {
            $clean_label = substr(sanitize_text_field((string) $label), 0, 80);
            if ($clean_label !== '') {
                $labels[] = $clean_label;
            }
        }

        $datasets = array();
        foreach (array_slice(isset($chart['datasets']) && is_array($chart['datasets']) ? $chart['datasets'] : array(), 0, 4) as $dataset) {
            if (!is_array($dataset)) {
                continue;
            }

            $data = array();
            foreach (array_slice(isset($dataset['data']) && is_array($dataset['data']) ? $dataset['data'] : array(), 0, count($labels)) as $value) {
                if (!is_numeric($value)) {
                    $data = array();
                    break;
                }
                $data[] = (float) $value;
            }

            if (count($data) !== count($labels) || count($data) === 0) {
                continue;
            }

            $datasets[] = array(
                'label' => substr(sanitize_text_field(isset($dataset['label']) ? (string) $dataset['label'] : 'Value'), 0, 80),
                'data' => $data,
            );
        }

        $title = substr(sanitize_text_field(isset($chart['title']) ? (string) $chart['title'] : ''), 0, 140);
        if ($title === '' || count($labels) === 0 || count($datasets) === 0) {
            continue;
        }

        $type = isset($chart['type']) && in_array($chart['type'], $allowed_types, true) ? $chart['type'] : 'bar';
        $validated[] = array(
            'type' => $type,
            'title' => $title,
            'description' => substr(sanitize_text_field(isset($chart['description']) ? (string) $chart['description'] : ''), 0, 220),
            'unit' => substr(sanitize_text_field(isset($chart['unit']) ? (string) $chart['unit'] : ''), 0, 24),
            'labels' => $labels,
            'datasets' => $datasets,
        );
    }

    return $validated;
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
    $allowed = array_merge(array(
        'open_page',
        'operational_note',
        'review_order',
        'review_report',
        'review_product',
        'review_stock',
        'follow_up_client',
        'review_customer',
        'review_coupon',
    ), array_map(function ($definition) {
        return $definition['type'];
    }, psa_wc_assistant_write_actions()));
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
            'charts' => array(),
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
        $parsed = array('answer' => $text !== '' ? $text : 'I could not produce a structured answer. Please try again.', 'citations' => array(), 'draftActions' => array(), 'charts' => array());
    }

    return array(
        'status' => psa_wc_assistant_status_payload(),
        'answer' => isset($parsed['answer']) ? (string) $parsed['answer'] : '',
        'citations' => isset($parsed['citations']) && is_array($parsed['citations']) ? $parsed['citations'] : array(),
        'draftActions' => psa_wc_assistant_validate_direct_draft_actions(isset($parsed['draftActions']) ? $parsed['draftActions'] : array(), $fallback_route),
        'charts' => psa_wc_assistant_validate_charts(isset($parsed['charts']) ? $parsed['charts'] : array()),
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
                'charts' => array(),
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
    $charts = psa_wc_assistant_validate_charts(isset($service_response['charts']) ? $service_response['charts'] : array());
    $assistant_message = psa_wc_assistant_add_message($conversation['id'], 'assistant', $answer, array(
        'citations' => isset($service_response['citations']) ? $service_response['citations'] : array(),
        'charts' => $charts,
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
        'charts' => $charts,
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

function psa_wc_assistant_rest_capabilities() {
    return rest_ensure_response(array(
        'status' => psa_wc_assistant_status_payload(),
        'capabilities' => array(
            'read' => array_map(function ($tool) {
                return array(
                    'mode' => 'read',
                    'name' => $tool['name'],
                    'title' => $tool['name'],
                    'description' => isset($tool['description']) ? $tool['description'] : '',
                    'resource' => strpos($tool['name'], 'product') !== false ? 'product' : 'business_data',
                    'risk' => 'low',
                );
            }, psa_wc_assistant_tool_definitions()),
            'write' => psa_wc_assistant_write_actions(),
        ),
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
    $operation = isset($item['operation']) && $item['operation'] !== ''
        ? sanitize_key($item['operation'])
        : sanitize_key(isset($defaults['operation']) ? $defaults['operation'] : '');
    if ($operation === '' && array_key_exists('newPrice', $item)) {
        $operation = 'set';
    }

    if (!$product_id || !in_array($price_field, array('regular_price', 'sale_price'), true)) {
        return new WP_Error('invalid_price_action', 'Invalid product price action payload.', array('status' => 400));
    }

    if (!array_key_exists('currentPrice', $item) || $operation === '') {
        return new WP_Error('invalid_price_action', 'Price action requires currentPrice and operation for every product.', array('status' => 400));
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

    if (!psa_wc_assistant_prices_match((string) $current_price, $expected_price)) {
        return new WP_Error('stale_price', 'Product price changed since this action was drafted.', array('status' => 409));
    }

    $mutation_payload = array_merge($defaults, $item);
    $new_price = psa_wc_assistant_calculate_category_price($product, $price_field, $operation, $mutation_payload);
    if (is_wp_error($new_price)) {
        return $new_price;
    }

    return array(
        'product' => $product,
        'result' => array(
            'productId' => $product_id,
            'variationId' => $variation_id ? $variation_id : null,
            'targetId' => $target_id,
            'priceField' => $price_field,
            'operation' => $operation,
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

function psa_wc_assistant_apply_price_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $prepared = psa_wc_assistant_prepare_price_update($payload, array());
    if (is_wp_error($prepared)) {
        return $prepared;
    }

    return $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_price_update($prepared);
}

function psa_wc_assistant_apply_bulk_price_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $items = isset($payload['items']) && is_array($payload['items']) ? $payload['items'] : array();
    $count = count($items);

    if ($count < 1 || $count > 50) {
        return new WP_Error('invalid_bulk_price_action', 'Bulk price actions must contain 1 to 50 products.', array('status' => 400));
    }

    $defaults = array(
        'priceField' => isset($payload['priceField']) ? sanitize_key($payload['priceField']) : '',
        'currency' => isset($payload['currency']) ? sanitize_text_field($payload['currency']) : '',
        'operation' => isset($payload['operation']) ? sanitize_key($payload['operation']) : '',
        'newPrice' => isset($payload['newPrice']) ? $payload['newPrice'] : null,
        'amount' => isset($payload['amount']) ? $payload['amount'] : null,
        'percent' => isset($payload['percent']) ? $payload['percent'] : null,
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
        $results[] = $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_price_update($prepared);
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

    if ($operation === 'set') {
        $operation = 'set_fixed';
    } elseif ($operation === 'clear') {
        $operation = 'clear_sale_price';
    }

    if ($operation === 'clear_sale_price') {
        if ($price_field !== 'sale_price') {
            return new WP_Error('invalid_category_price_operation', 'clear_sale_price can only be used with sale_price.', array('status' => 400));
        }
        return '';
    }

    if ($operation === 'set_fixed') {
        $new_price = isset($payload['newPrice']) ? wc_format_decimal($payload['newPrice'], $decimals) : '';
    } elseif (in_array($operation, array('increase_fixed', 'decrease_fixed'), true)) {
        $amount = isset($payload['amount']) ? (float) $payload['amount'] : 0;
        $base_price = $current_price === '' && $price_field === 'sale_price' ? $regular_price : $current_price;
        if ($amount <= 0 || $base_price === '') {
            return new WP_Error('invalid_category_price_amount', 'A fixed adjustment and current price are required.', array('status' => 400));
        }
        $new_price = $operation === 'increase_fixed'
            ? wc_format_decimal(((float) $base_price) + $amount, $decimals)
            : wc_format_decimal(((float) $base_price) - $amount, $decimals);
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

function psa_wc_assistant_apply_category_price_action($action, $dry_run = false) {
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

    if (!in_array($operation, array('set', 'set_fixed', 'decrease_percent', 'increase_percent', 'increase_fixed', 'decrease_fixed', 'set_percent_of_regular_price', 'clear', 'clear_sale_price'), true)) {
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
        $results[] = $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_price_update($prepared);
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

function psa_wc_assistant_values_match($actual, $expected) {
    if (is_array($actual) || is_array($expected)) {
        $actual_values = is_array($actual) ? array_values($actual) : array($actual);
        $expected_values = is_array($expected) ? array_values($expected) : array($expected);
        sort($actual_values);
        sort($expected_values);
        return wp_json_encode($actual_values) === wp_json_encode($expected_values);
    }

    if (is_bool($actual) || is_bool($expected)) {
        return (bool) $actual === (bool) $expected;
    }

    return (string) $actual === (string) $expected;
}

function psa_wc_assistant_allowed_detail_fields() {
    return array(
        'name', 'sku', 'shortDescription', 'description', 'status', 'featured', 'catalogVisibility',
        'categoryIds', 'tagIds', 'weight', 'length', 'width', 'height', 'taxStatus', 'taxClass',
        'purchaseNote', 'menuOrder', 'virtual'
    );
}

function psa_wc_assistant_current_detail_value($product, $field) {
    switch ($field) {
        case 'name':
            return $product->get_name('edit');
        case 'sku':
            return $product->get_sku('edit');
        case 'shortDescription':
            return method_exists($product, 'get_short_description') ? $product->get_short_description('edit') : '';
        case 'description':
            return method_exists($product, 'get_description') ? $product->get_description('edit') : '';
        case 'status':
            return $product->get_status('edit');
        case 'featured':
            return method_exists($product, 'get_featured') ? (bool) $product->get_featured('edit') : false;
        case 'catalogVisibility':
            return method_exists($product, 'get_catalog_visibility') ? $product->get_catalog_visibility('edit') : '';
        case 'categoryIds':
            return method_exists($product, 'get_category_ids') ? array_map('intval', $product->get_category_ids('edit')) : array();
        case 'tagIds':
            return method_exists($product, 'get_tag_ids') ? array_map('intval', $product->get_tag_ids('edit')) : array();
        case 'weight':
            return method_exists($product, 'get_weight') ? $product->get_weight('edit') : '';
        case 'length':
            return method_exists($product, 'get_length') ? $product->get_length('edit') : '';
        case 'width':
            return method_exists($product, 'get_width') ? $product->get_width('edit') : '';
        case 'height':
            return method_exists($product, 'get_height') ? $product->get_height('edit') : '';
        case 'taxStatus':
            return method_exists($product, 'get_tax_status') ? $product->get_tax_status('edit') : '';
        case 'taxClass':
            return method_exists($product, 'get_tax_class') ? $product->get_tax_class('edit') : '';
        case 'purchaseNote':
            return method_exists($product, 'get_purchase_note') ? $product->get_purchase_note('edit') : '';
        case 'menuOrder':
            return method_exists($product, 'get_menu_order') ? (int) $product->get_menu_order('edit') : 0;
        case 'virtual':
            return method_exists($product, 'get_virtual') ? (bool) $product->get_virtual('edit') : false;
        default:
            return null;
    }
}

function psa_wc_assistant_normalize_detail_fields($fields) {
    $fields = is_array($fields) ? $fields : array();
    $allowed = array_fill_keys(psa_wc_assistant_allowed_detail_fields(), true);
    $normalized = array();

    foreach ($fields as $field => $value) {
        if (!isset($allowed[$field])) {
            return new WP_Error('unsupported_product_detail_field', 'Unsupported product detail field: ' . sanitize_key($field), array('status' => 400));
        }

        if (in_array($field, array('name', 'sku', 'shortDescription', 'description', 'purchaseNote'), true)) {
            $normalized[$field] = sanitize_textarea_field((string) $value);
        } elseif ($field === 'status') {
            $status = sanitize_key($value);
            if (!in_array($status, array('publish', 'draft', 'pending', 'private'), true)) {
                return new WP_Error('invalid_product_status', 'Invalid product status.', array('status' => 400));
            }
            $normalized[$field] = $status;
        } elseif ($field === 'featured') {
            $normalized[$field] = (bool) $value;
        } elseif ($field === 'catalogVisibility') {
            $visibility = sanitize_key($value);
            if (!in_array($visibility, array('visible', 'catalog', 'search', 'hidden'), true)) {
                return new WP_Error('invalid_catalog_visibility', 'Invalid catalog visibility.', array('status' => 400));
            }
            $normalized[$field] = $visibility;
        } elseif (in_array($field, array('categoryIds', 'tagIds'), true)) {
            $ids = array_values(array_unique(array_filter(array_map('absint', is_array($value) ? $value : array()))));
            $taxonomy = $field === 'categoryIds' ? 'product_cat' : 'product_tag';
            foreach ($ids as $term_id) {
                if (!term_exists($term_id, $taxonomy)) {
                    return new WP_Error('invalid_product_term', 'One or more product category/tag ids do not exist.', array('status' => 400));
                }
            }
            $normalized[$field] = $ids;
        } elseif (in_array($field, array('weight', 'length', 'width', 'height'), true)) {
            $decimal = wc_format_decimal($value);
            if ($decimal !== '' && (float) $decimal < 0) {
                return new WP_Error('invalid_product_measurement', 'Product measurements cannot be negative.', array('status' => 400));
            }
            $normalized[$field] = $decimal;
        } elseif ($field === 'taxStatus') {
            $tax_status = sanitize_key($value);
            if (!in_array($tax_status, array('taxable', 'shipping', 'none'), true)) {
                return new WP_Error('invalid_product_tax_status', 'Invalid product tax status.', array('status' => 400));
            }
            $normalized[$field] = $tax_status;
        } elseif ($field === 'taxClass') {
            $normalized[$field] = sanitize_title($value);
        } elseif ($field === 'menuOrder') {
            $normalized[$field] = (int) $value;
        } elseif ($field === 'virtual') {
            $normalized[$field] = (bool) $value;
        }
    }

    if (count($normalized) === 0) {
        return new WP_Error('missing_product_detail_fields', 'At least one product detail field is required.', array('status' => 400));
    }

    return $normalized;
}

function psa_wc_assistant_prepare_detail_update($item, $default_fields = null) {
    $item = is_array($item) ? $item : array();
    $product_id = isset($item['productId']) ? absint($item['productId']) : 0;
    $variation_id = isset($item['variationId']) ? absint($item['variationId']) : 0;
    $target_id = $variation_id ? $variation_id : $product_id;

    if (!$product_id || !$target_id) {
        return new WP_Error('invalid_product_detail_action', 'Invalid product detail action payload.', array('status' => 400));
    }

    if (!current_user_can('manage_woocommerce') || !current_user_can('edit_product', $product_id)) {
        return new WP_Error('product_detail_forbidden', 'You are not allowed to update this product.', array('status' => 403));
    }

    $product = wc_get_product($target_id);
    if (!$product) {
        return new WP_Error('product_not_found', 'Product or variation not found.', array('status' => 404));
    }

    if ($variation_id && (int) $product->get_parent_id() !== (int) $product_id) {
        return new WP_Error('variation_mismatch', 'Variation does not belong to the supplied product.', array('status' => 400));
    }

    $fields = array_key_exists('fields', $item) ? $item['fields'] : $default_fields;
    $fields = psa_wc_assistant_normalize_detail_fields($fields);
    if (is_wp_error($fields)) {
        return $fields;
    }

    if ($variation_id) {
        foreach (array('shortDescription', 'featured', 'catalogVisibility', 'categoryIds', 'tagIds', 'purchaseNote', 'menuOrder') as $field) {
            if (array_key_exists($field, $fields)) {
                return new WP_Error('unsupported_variation_detail_field', 'This detail field is not supported for variations: ' . $field, array('status' => 400));
            }
        }
    }

    $current_values = isset($item['currentValues']) && is_array($item['currentValues']) ? $item['currentValues'] : array();
    foreach ($current_values as $field => $expected) {
        if (array_key_exists($field, $fields)) {
            $actual = psa_wc_assistant_current_detail_value($product, $field);
            if (!psa_wc_assistant_values_match($actual, $expected)) {
                return new WP_Error('stale_product_detail', 'Product details changed since this action was drafted.', array('status' => 409));
            }
        }
    }

    $old_values = array();
    foreach ($fields as $field => $_) {
        $old_values[$field] = psa_wc_assistant_current_detail_value($product, $field);
    }

    return array(
        'product' => $product,
        'fields' => $fields,
        'result' => array(
            'productId' => $product_id,
            'variationId' => $variation_id ? $variation_id : null,
            'targetId' => $target_id,
            'oldValues' => $old_values,
            'newValues' => $fields,
        ),
    );
}

function psa_wc_assistant_save_prepared_detail_update($prepared) {
    $product = $prepared['product'];
    foreach ($prepared['fields'] as $field => $value) {
        if ($field === 'name') {
            $product->set_name($value);
        } elseif ($field === 'sku') {
            $product->set_sku($value);
        } elseif ($field === 'shortDescription' && method_exists($product, 'set_short_description')) {
            $product->set_short_description($value);
        } elseif ($field === 'description' && method_exists($product, 'set_description')) {
            $product->set_description($value);
        } elseif ($field === 'status') {
            $product->set_status($value);
        } elseif ($field === 'featured' && method_exists($product, 'set_featured')) {
            $product->set_featured((bool) $value);
        } elseif ($field === 'catalogVisibility' && method_exists($product, 'set_catalog_visibility')) {
            $product->set_catalog_visibility($value);
        } elseif ($field === 'categoryIds' && method_exists($product, 'set_category_ids')) {
            $product->set_category_ids($value);
        } elseif ($field === 'tagIds' && method_exists($product, 'set_tag_ids')) {
            $product->set_tag_ids($value);
        } elseif ($field === 'weight' && method_exists($product, 'set_weight')) {
            $product->set_weight($value);
        } elseif ($field === 'length' && method_exists($product, 'set_length')) {
            $product->set_length($value);
        } elseif ($field === 'width' && method_exists($product, 'set_width')) {
            $product->set_width($value);
        } elseif ($field === 'height' && method_exists($product, 'set_height')) {
            $product->set_height($value);
        } elseif ($field === 'taxStatus' && method_exists($product, 'set_tax_status')) {
            $product->set_tax_status($value);
        } elseif ($field === 'taxClass' && method_exists($product, 'set_tax_class')) {
            $product->set_tax_class($value);
        } elseif ($field === 'purchaseNote' && method_exists($product, 'set_purchase_note')) {
            $product->set_purchase_note($value);
        } elseif ($field === 'menuOrder' && method_exists($product, 'set_menu_order')) {
            $product->set_menu_order($value);
        } elseif ($field === 'virtual' && method_exists($product, 'set_virtual')) {
            $product->set_virtual((bool) $value);
        }
    }
    $product->save();
    return $prepared['result'];
}

function psa_wc_assistant_apply_detail_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $prepared = psa_wc_assistant_prepare_detail_update($payload);
    if (is_wp_error($prepared)) {
        return $prepared;
    }

    return $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_detail_update($prepared);
}

function psa_wc_assistant_apply_bulk_detail_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $items = isset($payload['items']) && is_array($payload['items']) ? $payload['items'] : array();
    if (count($items) < 1 || count($items) > 50) {
        return new WP_Error('invalid_bulk_detail_action', 'Bulk detail actions must contain 1 to 50 products.', array('status' => 400));
    }

    $prepared_updates = array();
    $seen = array();
    foreach ($items as $item) {
        $prepared = psa_wc_assistant_prepare_detail_update($item);
        if (is_wp_error($prepared)) {
            return $prepared;
        }
        $key = (string) $prepared['result']['targetId'];
        if (isset($seen[$key])) {
            return new WP_Error('duplicate_detail_action_item', 'Bulk detail action contains the same product more than once.', array('status' => 400));
        }
        $seen[$key] = true;
        $prepared_updates[] = $prepared;
    }

    $results = array();
    foreach ($prepared_updates as $prepared) {
        $results[] = $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_detail_update($prepared);
    }

    return array('updatedCount' => count($results), 'items' => $results);
}

function psa_wc_assistant_apply_category_detail_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $term = psa_wc_assistant_resolve_product_category($payload);
    if (is_wp_error($term)) {
        return $term;
    }

    $max_items = psa_wc_assistant_limit(isset($payload['maxItems']) ? $payload['maxItems'] : 100, 100, 100);
    $include_variations = !isset($payload['includeVariations']) || (bool) $payload['includeVariations'];
    $fields = isset($payload['fields']) ? $payload['fields'] : array();
    $collection = psa_wc_assistant_collect_category_price_targets($term, $include_variations, $max_items);
    if ($collection['truncated']) {
        return new WP_Error('category_detail_limit_exceeded', 'This category has more products than the allowed bulk detail update limit.', array('status' => 400));
    }

    $prepared_updates = array();
    foreach ($collection['products'] as $product) {
        $prepared = psa_wc_assistant_prepare_detail_update(array(
            'productId' => $product->get_parent_id() ? $product->get_parent_id() : $product->get_id(),
            'variationId' => $product->get_parent_id() ? $product->get_id() : null,
        ), $fields);
        if (is_wp_error($prepared)) {
            return $prepared;
        }
        $prepared_updates[] = $prepared;
    }

    if (count($prepared_updates) === 0) {
        return new WP_Error('category_has_no_products', 'No supported products were found in this category.', array('status' => 404));
    }

    $results = array();
    foreach ($prepared_updates as $prepared) {
        $results[] = $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_detail_update($prepared);
    }

    return array(
        'updatedCount' => count($results),
        'category' => psa_wc_assistant_category_data($term),
        'items' => $results,
    );
}

function psa_wc_assistant_allowed_inventory_fields() {
    return array('manageStock', 'stockQuantity', 'stockStatus', 'backorders', 'lowStockAmount');
}

function psa_wc_assistant_current_inventory_value($product, $field) {
    switch ($field) {
        case 'manageStock':
            return (bool) $product->get_manage_stock('edit');
        case 'stockQuantity':
            return $product->get_stock_quantity('edit');
        case 'stockStatus':
            return $product->get_stock_status('edit');
        case 'backorders':
            return $product->get_backorders('edit');
        case 'lowStockAmount':
            return method_exists($product, 'get_low_stock_amount') ? $product->get_low_stock_amount('edit') : '';
        default:
            return null;
    }
}

function psa_wc_assistant_normalize_inventory_fields($fields) {
    $fields = is_array($fields) ? $fields : array();
    $allowed = array_fill_keys(psa_wc_assistant_allowed_inventory_fields(), true);
    $normalized = array();

    foreach ($fields as $field => $value) {
        if (!isset($allowed[$field])) {
            return new WP_Error('unsupported_inventory_field', 'Unsupported inventory field: ' . sanitize_key($field), array('status' => 400));
        }

        if ($field === 'manageStock') {
            $normalized[$field] = (bool) $value;
        } elseif ($field === 'stockQuantity') {
            if (!is_numeric($value) || (int) $value < 0) {
                return new WP_Error('invalid_stock_quantity', 'Stock quantity must be a non-negative number.', array('status' => 400));
            }
            $normalized[$field] = (int) $value;
        } elseif ($field === 'stockStatus') {
            $status = sanitize_key($value);
            if (!in_array($status, array('instock', 'outofstock', 'onbackorder'), true)) {
                return new WP_Error('invalid_stock_status', 'Invalid stock status.', array('status' => 400));
            }
            $normalized[$field] = $status;
        } elseif ($field === 'backorders') {
            $backorders = sanitize_key($value);
            if (!in_array($backorders, array('no', 'notify', 'yes'), true)) {
                return new WP_Error('invalid_backorders', 'Invalid backorders setting.', array('status' => 400));
            }
            $normalized[$field] = $backorders;
        } elseif ($field === 'lowStockAmount') {
            if ($value !== '' && $value !== null && (!is_numeric($value) || (float) $value < 0)) {
                return new WP_Error('invalid_low_stock_amount', 'Low stock amount must be empty or non-negative.', array('status' => 400));
            }
            $normalized[$field] = ($value === '' || $value === null) ? '' : (float) $value;
        }
    }

    if (count($normalized) === 0) {
        return new WP_Error('missing_inventory_fields', 'At least one inventory field is required.', array('status' => 400));
    }

    return $normalized;
}

function psa_wc_assistant_prepare_inventory_update($item, $default_fields = null) {
    $item = is_array($item) ? $item : array();
    $product_id = isset($item['productId']) ? absint($item['productId']) : 0;
    $variation_id = isset($item['variationId']) ? absint($item['variationId']) : 0;
    $target_id = $variation_id ? $variation_id : $product_id;

    if (!$product_id || !$target_id) {
        return new WP_Error('invalid_inventory_action', 'Invalid product inventory action payload.', array('status' => 400));
    }
    if (!current_user_can('manage_woocommerce') || !current_user_can('edit_product', $product_id)) {
        return new WP_Error('inventory_action_forbidden', 'You are not allowed to update this product inventory.', array('status' => 403));
    }

    $product = wc_get_product($target_id);
    if (!$product) {
        return new WP_Error('product_not_found', 'Product or variation not found.', array('status' => 404));
    }
    if ($variation_id && (int) $product->get_parent_id() !== (int) $product_id) {
        return new WP_Error('variation_mismatch', 'Variation does not belong to the supplied product.', array('status' => 400));
    }

    $fields = array_key_exists('fields', $item) ? $item['fields'] : $default_fields;
    $fields = psa_wc_assistant_normalize_inventory_fields($fields);
    if (is_wp_error($fields)) return $fields;

    $will_manage_stock = array_key_exists('manageStock', $fields)
        ? (bool) $fields['manageStock']
        : (bool) $product->get_manage_stock('edit');
    if (array_key_exists('stockQuantity', $fields) && !$will_manage_stock) {
        return new WP_Error('stock_management_required', 'Set manageStock to true before changing stock quantity.', array('status' => 400));
    }

    $current_values = isset($item['currentValues']) && is_array($item['currentValues']) ? $item['currentValues'] : array();
    foreach ($current_values as $field => $expected) {
        if (array_key_exists($field, $fields)
            && !psa_wc_assistant_values_match(psa_wc_assistant_current_inventory_value($product, $field), $expected)) {
            return new WP_Error('stale_product_inventory', 'Product inventory changed since this action was drafted.', array('status' => 409));
        }
    }

    $old_values = array();
    foreach ($fields as $field => $_) {
        $old_values[$field] = psa_wc_assistant_current_inventory_value($product, $field);
    }

    return array(
        'product' => $product,
        'fields' => $fields,
        'result' => array(
            'productId' => $product_id,
            'variationId' => $variation_id ? $variation_id : null,
            'targetId' => $target_id,
            'name' => $product->get_name(),
            'oldValues' => $old_values,
            'newValues' => $fields,
        ),
    );
}

function psa_wc_assistant_save_prepared_inventory_update($prepared) {
    $product = $prepared['product'];
    foreach ($prepared['fields'] as $field => $value) {
        if ($field === 'manageStock') {
            $product->set_manage_stock((bool) $value);
        } elseif ($field === 'stockQuantity') {
            $product->set_stock_quantity($value);
        } elseif ($field === 'stockStatus') {
            $product->set_stock_status($value);
        } elseif ($field === 'backorders') {
            $product->set_backorders($value);
        } elseif ($field === 'lowStockAmount' && method_exists($product, 'set_low_stock_amount')) {
            $product->set_low_stock_amount($value);
        }
    }
    $product->save();
    return $prepared['result'];
}

function psa_wc_assistant_apply_inventory_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $prepared = psa_wc_assistant_prepare_inventory_update($payload);
    return is_wp_error($prepared) ? $prepared : ($dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_inventory_update($prepared));
}

function psa_wc_assistant_apply_bulk_inventory_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $items = isset($payload['items']) && is_array($payload['items']) ? $payload['items'] : array();
    if (count($items) < 1 || count($items) > 50) {
        return new WP_Error('invalid_bulk_inventory_action', 'Bulk inventory actions must contain 1 to 50 products.', array('status' => 400));
    }

    $prepared_updates = array();
    $seen = array();
    foreach ($items as $item) {
        $prepared = psa_wc_assistant_prepare_inventory_update($item);
        if (is_wp_error($prepared)) return $prepared;
        $key = (string) $prepared['result']['targetId'];
        if (isset($seen[$key])) {
            return new WP_Error('duplicate_inventory_action_item', 'Bulk inventory action contains a duplicate product.', array('status' => 400));
        }
        $seen[$key] = true;
        $prepared_updates[] = $prepared;
    }

    $results = array();
    foreach ($prepared_updates as $prepared) {
        $results[] = $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_inventory_update($prepared);
    }
    return array('updatedCount' => count($results), 'items' => $results);
}

function psa_wc_assistant_apply_category_inventory_action($action, $dry_run = false) {
    $payload = isset($action['payload']) && is_array($action['payload']) ? $action['payload'] : array();
    $term = psa_wc_assistant_resolve_product_category($payload);
    if (is_wp_error($term)) return $term;

    $max_items = psa_wc_assistant_limit(isset($payload['maxItems']) ? $payload['maxItems'] : 100, 100, 100);
    $include_variations = !isset($payload['includeVariations']) || (bool) $payload['includeVariations'];
    $fields = isset($payload['fields']) ? $payload['fields'] : array();
    $collection = psa_wc_assistant_collect_category_price_targets($term, $include_variations, $max_items);
    if ($collection['truncated']) {
        return new WP_Error('category_inventory_limit_exceeded', 'This category exceeds the allowed bulk inventory limit.', array('status' => 400));
    }

    $prepared_updates = array();
    foreach ($collection['products'] as $product) {
        $prepared = psa_wc_assistant_prepare_inventory_update(array(
            'productId' => $product->get_parent_id() ? $product->get_parent_id() : $product->get_id(),
            'variationId' => $product->get_parent_id() ? $product->get_id() : null,
        ), $fields);
        if (is_wp_error($prepared)) return $prepared;
        $prepared_updates[] = $prepared;
    }
    if (!count($prepared_updates)) {
        return new WP_Error('category_has_no_products', 'No supported products were found in this category.', array('status' => 404));
    }

    $results = array();
    foreach ($prepared_updates as $prepared) {
        $results[] = $dry_run ? $prepared['result'] : psa_wc_assistant_save_prepared_inventory_update($prepared);
    }
    return array('updatedCount' => count($results), 'category' => psa_wc_assistant_category_data($term), 'items' => $results);
}

function psa_wc_assistant_write_action_handlers() {
    return array(
        'update_woocommerce_product_price' => 'psa_wc_assistant_apply_price_action',
        'bulk_update_woocommerce_product_prices' => 'psa_wc_assistant_apply_bulk_price_action',
        'bulk_update_woocommerce_category_product_prices' => 'psa_wc_assistant_apply_category_price_action',
        'update_woocommerce_product_details' => 'psa_wc_assistant_apply_detail_action',
        'bulk_update_woocommerce_product_details' => 'psa_wc_assistant_apply_bulk_detail_action',
        'bulk_update_woocommerce_category_product_details' => 'psa_wc_assistant_apply_category_detail_action',
        'update_woocommerce_product_inventory' => 'psa_wc_assistant_apply_inventory_action',
        'bulk_update_woocommerce_product_inventory' => 'psa_wc_assistant_apply_bulk_inventory_action',
        'bulk_update_woocommerce_category_product_inventory' => 'psa_wc_assistant_apply_category_inventory_action',
    );
}

function psa_wc_assistant_execute_write_action($handler, $action) {
    $transaction_started = false;
    try {
        if (function_exists('wc_transaction_query')) {
            wc_transaction_query('start');
            $transaction_started = true;
        }

        $result = call_user_func($handler, $action, false);
        if (is_wp_error($result)) {
            if ($transaction_started) wc_transaction_query('rollback');
            return $result;
        }

        if ($transaction_started) wc_transaction_query('commit');
        return $result;
    } catch (Throwable $error) {
        if ($transaction_started) wc_transaction_query('rollback');
        return new WP_Error(
            'assistant_write_action_failed',
            $error->getMessage() ? $error->getMessage() : 'WooCommerce product update failed.',
            array('status' => 500)
        );
    }
}

function psa_wc_assistant_preview_write_action($action) {
    $handlers = psa_wc_assistant_write_action_handlers();
    if (!isset($handlers[$action['type']])) {
        return new WP_Error('unsupported_write_action', 'Unsupported assistant write action.', array('status' => 400));
    }

    $result = call_user_func($handlers[$action['type']], $action, true);
    if (is_wp_error($result)) return $result;

    $items = isset($result['items']) && is_array($result['items']) ? $result['items'] : array($result);
    $definition = psa_wc_assistant_write_action_definition($action['type']);
    $max_items = $definition && isset($definition['maxBatchSize']) ? (int) $definition['maxBatchSize'] : count($items);
    if (count($items) > $max_items) {
        return new WP_Error('write_action_limit_exceeded', 'The action exceeds its configured record limit.', array('status' => 400));
    }

    return array(
        'actionType' => $action['type'],
        'resource' => $definition ? $definition['resource'] : 'product',
        'scope' => $definition ? $definition['scope'] : 'single',
        'risk' => $definition ? $definition['risk'] : 'high',
        'requiresUserReview' => true,
        'maxBatchSize' => $max_items,
        'summary' => $definition ? $definition['title'] : 'Review product changes',
        'affectedCount' => count($items),
        'truncated' => false,
        'items' => array_slice(array_map(function ($item) {
            return array(
                'id' => isset($item['targetId']) ? $item['targetId'] : (isset($item['productId']) ? $item['productId'] : null),
                'name' => isset($item['name']) ? $item['name'] : '',
            );
        }, $items), 0, 20),
        'changes' => array_slice($items, 0, 20),
        'warnings' => array(),
        'fingerprint' => hash('sha256', wp_json_encode($items)),
    );
}

function psa_wc_assistant_transition_draft_action_status($id, $from_statuses, $status, $metadata = array()) {
    global $wpdb;
    $table = psa_wc_assistant_table('draft_actions');
    $from_statuses = array_values(array_filter(array_map('sanitize_key', (array) $from_statuses)));
    if (!count($from_statuses)) return null;

    $placeholders = implode(', ', array_fill(0, count($from_statuses), '%s'));
    $sql = "UPDATE {$table} SET status = %s, metadata = %s WHERE id = %d AND status IN ({$placeholders})";
    $args = array_merge(array(sanitize_key($status), psa_wc_json_encode($metadata), absint($id)), $from_statuses);
    $prepared_sql = call_user_func_array(array($wpdb, 'prepare'), array_merge(array($sql), $args));
    $updated = $wpdb->query($prepared_sql);
    return $updated === 1 ? psa_wc_assistant_get_draft_action($id) : null;
}

function psa_wc_assistant_rest_preview_draft_action($request) {
    $action = psa_wc_assistant_get_draft_action(absint($request['id']));
    if (!$action) {
        return new WP_Error('draft_action_not_found', 'Draft action not found.', array('status' => 404));
    }
    if (!in_array($action['status'], array('draft', 'failed'), true)) {
        return new WP_Error('invalid_draft_action_status', 'Draft action cannot be previewed from this status.', array('status' => 409));
    }

    $preview = psa_wc_assistant_preview_write_action($action);
    if (is_wp_error($preview)) return $preview;
    return rest_ensure_response(array(
        'draftAction' => $action,
        'capability' => psa_wc_assistant_write_action_definition($action['type']),
        'preview' => $preview,
    ));
}

function psa_wc_assistant_rest_apply_draft_action($request) {
    $action = psa_wc_assistant_get_draft_action(absint($request['id']));
    if (!$action) {
        return new WP_Error('draft_action_not_found', 'Draft action not found.', array('status' => 404));
    }

    if (!in_array($action['status'], array('draft', 'failed'), true)) {
        return new WP_Error('invalid_draft_action_status', 'Draft action cannot be applied from this status.', array('status' => 409));
    }

    $handlers = psa_wc_assistant_write_action_handlers();
    if (!isset($handlers[$action['type']])) {
        return new WP_Error('unsupported_write_action', 'Unsupported assistant write action.', array('status' => 400));
    }

    $preview = psa_wc_assistant_preview_write_action($action);
    if (is_wp_error($preview)) return $preview;

    $metadata = array_merge($action['metadata'], array(
        'applyingAt' => psa_wc_assistant_now(),
        'applyingBy' => get_current_user_id(),
        'preview' => $preview,
    ));
    $claimed = psa_wc_assistant_transition_draft_action_status(
        $action['id'],
        array('draft', 'failed'),
        'applying',
        $metadata
    );
    if (!$claimed) {
        return new WP_Error('draft_action_already_processing', 'Draft action is already being processed.', array('status' => 409));
    }

    $result = psa_wc_assistant_execute_write_action($handlers[$action['type']], $claimed);
    if (is_wp_error($result)) {
        psa_wc_assistant_update_draft_action_status($action['id'], 'failed', array_merge($metadata, array(
            'failedAt' => psa_wc_assistant_now(),
            'error' => $result->get_error_message(),
        )));
        return $result;
    }

    $saved = psa_wc_assistant_update_draft_action_status($action['id'], 'applied', array_merge($metadata, array(
        'appliedAt' => psa_wc_assistant_now(),
        'appliedBy' => get_current_user_id(),
        'applyResult' => $result,
    )));

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

    $saved = psa_wc_assistant_transition_draft_action_status($action['id'], array('draft', 'failed'), 'rejected', array_merge($action['metadata'], array(
        'rejectedAt' => psa_wc_assistant_now(),
        'rejectedBy' => get_current_user_id(),
    )));

    if (!$saved) {
        return new WP_Error('draft_action_already_processing', 'Draft action is already being processed.', array('status' => 409));
    }

    return rest_ensure_response(array('draftAction' => $saved));
}
