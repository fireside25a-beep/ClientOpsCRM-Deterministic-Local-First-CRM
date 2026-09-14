#include "config.h"
#include "cJSON.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void set_error(char *error, size_t error_size, const char *message) {
    if ((error != NULL) && (error_size > 0U)) {
        (void)lead_copy_string(error, error_size, message);
    }
}

static char *read_config_file(const char *path, size_t *length, char *error, size_t error_size) {
    FILE *file = NULL;
    char *data = NULL;
    long file_size = 0L;
    size_t read_count = 0U;
    char message[LEAD_ERROR_MAX];

    file = fopen(path, "rb");
    if (file == NULL) {
        (void)snprintf(message, sizeof(message), "cannot open config: %s", strerror(errno));
        set_error(error, error_size, message);
        return NULL;
    }
    if ((fseek(file, 0L, SEEK_END) != 0) || ((file_size = ftell(file)) < 0L) ||
        (fseek(file, 0L, SEEK_SET) != 0)) {
        set_error(error, error_size, "cannot inspect config file");
        (void)fclose(file);
        return NULL;
    }
    if (file_size > 1024L * 1024L) {
        set_error(error, error_size, "config exceeds 1 MiB limit");
        (void)fclose(file);
        return NULL;
    }
    data = (char *)malloc((size_t)file_size + 1U);
    if (data == NULL) {
        set_error(error, error_size, "out of memory reading config");
        (void)fclose(file);
        return NULL;
    }
    read_count = fread(data, 1U, (size_t)file_size, file);
    if ((read_count != (size_t)file_size) || ferror(file)) {
        set_error(error, error_size, "cannot read config file");
        free(data);
        (void)fclose(file);
        return NULL;
    }
    data[read_count] = '\0';
    *length = read_count;
    (void)fclose(file);
    return data;
}

static bool bounded_text_is_valid(const char *value, size_t maximum) {
    const unsigned char *cursor = (const unsigned char *)value;
    size_t length = 0U;
    if (value == NULL) {
        return false;
    }
    length = strlen(value);
    if ((length == 0U) || (length >= maximum)) {
        return false;
    }
    while (*cursor != '\0') {
        if ((*cursor < 0x20U) || (*cursor == 0x7fU)) {
            return false;
        }
        ++cursor;
    }
    return true;
}

static bool category_name_is_valid(const char *value) {
    const unsigned char *cursor = (const unsigned char *)value;
    if (!bounded_text_is_valid(value, LEAD_CATEGORY_MAX)) {
        return false;
    }
    while (*cursor != '\0') {
        if (!(islower(*cursor) || isdigit(*cursor) || (*cursor == '_') || (*cursor == '-'))) {
            return false;
        }
        ++cursor;
    }
    return true;
}

static bool add_keyword(char destination[][CONFIG_KEYWORD_MAX], size_t maximum,
                        size_t *count, const char *keyword) {
    if ((destination == NULL) || (count == NULL) || (*count >= maximum) ||
        !bounded_text_is_valid(keyword, CONFIG_KEYWORD_MAX)) {
        return false;
    }
    if (!lead_copy_string(destination[*count], CONFIG_KEYWORD_MAX, keyword)) {
        return false;
    }
    ++(*count);
    return true;
}

static CategoryRule *add_category(LeadConfig *config, const char *name, bool specialist) {
    CategoryRule *category = NULL;
    size_t i = 0U;
    if ((config == NULL) || !category_name_is_valid(name) ||
        (config->category_count >= CONFIG_MAX_CATEGORIES)) {
        return NULL;
    }
    for (i = 0U; i < config->category_count; ++i) {
        if (strcmp(config->categories[i].name, name) == 0) {
            return NULL;
        }
    }
    category = &config->categories[config->category_count++];
    memset(category, 0, sizeof(*category));
    (void)lead_copy_string(category->name, sizeof(category->name), name);
    category->specialist = specialist;
    return category;
}

static void add_default_category(LeadConfig *config, const char *name, bool specialist,
                                 const char *const *keywords, size_t keyword_count) {
    CategoryRule *category = add_category(config, name, specialist);
    size_t i = 0U;
    if (category == NULL) {
        return;
    }
    for (i = 0U; i < keyword_count; ++i) {
        (void)add_keyword(category->keywords, CONFIG_MAX_CATEGORY_KEYWORDS,
                          &category->keyword_count, keywords[i]);
    }
}

void lead_config_defaults(LeadConfig *config) {
    static const char *const sales[] = {
        "quote", "pricing", "price", "purchase", "proposal", "demo", "consultation"
    };
    static const char *const support[] = {
        "support", "issue", "problem", "not working", "cannot access", "account locked", "error"
    };
    static const char *const partnership[] = {
        "partnership", "partner", "collaboration", "referral", "integration", "reseller"
    };
    static const char *const high[] = {
        "urgent", "urgently", "asap", "critical", "immediately", "today", "blocked", "outage"
    };
    static const char *const low[] = {
        "no rush", "not urgent", "whenever convenient", "just researching"
    };
    static const char *const spam[] = {
        "buy backlinks", "guest post placement", "guaranteed page-one rankings",
        "crypto investment opportunity", "casino promotion"
    };
    size_t i = 0U;

    if (config == NULL) {
        return;
    }
    memset(config, 0, sizeof(*config));
    (void)lead_copy_string(config->fallback_category, sizeof(config->fallback_category), "general");
    config->location_allowlist_enabled = false;
    config->unknown_location_serviceable = true;
    config->minimum_detail_words = 3U;
    add_default_category(config, "sales", false, sales, sizeof(sales) / sizeof(sales[0]));
    add_default_category(config, "support", true, support, sizeof(support) / sizeof(support[0]));
    add_default_category(config, "partnership", true, partnership,
                         sizeof(partnership) / sizeof(partnership[0]));
    for (i = 0U; i < sizeof(high) / sizeof(high[0]); ++i) {
        (void)add_keyword(config->high_priority_keywords, CONFIG_MAX_KEYWORDS,
                          &config->high_priority_keyword_count, high[i]);
    }
    for (i = 0U; i < sizeof(low) / sizeof(low[0]); ++i) {
        (void)add_keyword(config->low_priority_keywords, CONFIG_MAX_KEYWORDS,
                          &config->low_priority_keyword_count, low[i]);
    }
    for (i = 0U; i < sizeof(spam) / sizeof(spam[0]); ++i) {
        (void)add_keyword(config->spam_keywords, CONFIG_MAX_KEYWORDS,
                          &config->spam_keyword_count, spam[i]);
    }
}

static bool load_string_array(cJSON *array, char destination[][CONFIG_KEYWORD_MAX],
                              size_t maximum, size_t *count) {
    int i = 0;
    int size = 0;
    if (!cJSON_IsArray(array)) {
        return false;
    }
    size = cJSON_GetArraySize(array);
    *count = 0U;
    for (i = 0; i < size; ++i) {
        cJSON *item = cJSON_GetArrayItem(array, i);
        if (!cJSON_IsString(item) || !add_keyword(destination, maximum, count,
                                                  item->valuestring)) {
            return false;
        }
    }
    return true;
}

static bool load_location_array(cJSON *array, LeadConfig *config) {
    int i = 0;
    int size = 0;
    if (!cJSON_IsArray(array)) {
        return false;
    }
    size = cJSON_GetArraySize(array);
    config->allowed_location_count = 0U;
    for (i = 0; i < size; ++i) {
        cJSON *item = cJSON_GetArrayItem(array, i);
        if (!cJSON_IsString(item) || (config->allowed_location_count >= CONFIG_MAX_KEYWORDS) ||
            !bounded_text_is_valid(item->valuestring, LEAD_CITY_MAX) ||
            !lead_copy_string(config->allowed_locations[config->allowed_location_count],
                              LEAD_CITY_MAX, item->valuestring)) {
            return false;
        }
        ++config->allowed_location_count;
    }
    return true;
}

static bool load_categories(cJSON *array, LeadConfig *config) {
    int i = 0;
    int count = 0;
    if (!cJSON_IsArray(array)) {
        return false;
    }
    config->category_count = 0U;
    memset(config->categories, 0, sizeof(config->categories));
    count = cJSON_GetArraySize(array);
    for (i = 0; i < count; ++i) {
        cJSON *entry = cJSON_GetArrayItem(array, i);
        cJSON *name = cJSON_GetObjectItemCaseSensitive(entry, "name");
        cJSON *specialist = cJSON_GetObjectItemCaseSensitive(entry, "specialist");
        cJSON *keywords = cJSON_GetObjectItemCaseSensitive(entry, "keywords");
        CategoryRule *category = NULL;
        if (!cJSON_IsObject(entry) || !cJSON_IsString(name) || !cJSON_IsBool(specialist) ||
            !cJSON_IsArray(keywords) || (cJSON_GetArraySize(keywords) == 0)) {
            return false;
        }
        category = add_category(config, name->valuestring, cJSON_IsTrue(specialist));
        if ((category == NULL) ||
            !load_string_array(keywords, category->keywords, CONFIG_MAX_CATEGORY_KEYWORDS,
                               &category->keyword_count)) {
            return false;
        }
    }
    return true;
}

static bool json_number_is_integer_in_range(const cJSON *item, double minimum, double maximum) {
    double value = 0.0;
    if (!cJSON_IsNumber(item)) {
        return false;
    }
    value = item->valuedouble;
    return isfinite(value) && (value >= minimum) && (value <= maximum) &&
           (floor(value) == value);
}

static bool config_key_is_allowed(const char *key) {
    static const char *const allowed[] = {
        "categories", "fallback_category", "location_mode", "allowed_locations",
        "unknown_location_serviceable", "high_priority_keywords", "low_priority_keywords",
        "spam_keywords", "out_of_scope_keywords", "minimum_detail_words"
    };
    size_t i = 0U;
    for (i = 0U; i < sizeof(allowed) / sizeof(allowed[0]); ++i) {
        if (strcmp(key, allowed[i]) == 0) {
            return true;
        }
    }
    return false;
}

bool lead_config_load_json(const char *path, LeadConfig *config, char *error, size_t error_size) {
    char *data = NULL;
    size_t length = 0U;
    const char *end = NULL;
    cJSON *root = NULL;
    cJSON *item = NULL;
    cJSON *cursor = NULL;
    LeadConfig loaded;

    if ((path == NULL) || (config == NULL)) {
        set_error(error, error_size, "invalid config arguments");
        return false;
    }
    lead_config_defaults(&loaded);
    data = read_config_file(path, &length, error, error_size);
    (void)length;
    if (data == NULL) {
        return false;
    }
    root = cJSON_ParseWithOpts(data, &end, 1);
    free(data);
    if ((root == NULL) || !cJSON_IsObject(root)) {
        set_error(error, error_size, "config must be exactly one JSON object");
        cJSON_Delete(root);
        return false;
    }
    for (cursor = root->child; cursor != NULL; cursor = cursor->next) {
        if ((cursor->string == NULL) || !config_key_is_allowed(cursor->string)) {
            set_error(error, error_size, "config contains an unknown field");
            cJSON_Delete(root);
            return false;
        }
    }

    item = cJSON_GetObjectItemCaseSensitive(root, "categories");
    if ((item != NULL) && !load_categories(item, &loaded)) {
        set_error(error, error_size, "categories must contain bounded unique names, boolean specialist flags, and keyword arrays");
        cJSON_Delete(root);
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "fallback_category");
    if (item != NULL) {
        if (!cJSON_IsString(item) || (item->valuestring == NULL) ||
            ((item->valuestring[0] != '\0') && !category_name_is_valid(item->valuestring)) ||
            !lead_copy_string(loaded.fallback_category, sizeof(loaded.fallback_category),
                              item->valuestring)) {
            set_error(error, error_size, "fallback_category must be empty or a bounded lowercase identifier");
            cJSON_Delete(root);
            return false;
        }
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "location_mode");
    if (item != NULL) {
        if (!cJSON_IsString(item) || (item->valuestring == NULL) ||
            ((strcmp(item->valuestring, "any") != 0) &&
             (strcmp(item->valuestring, "allowlist") != 0))) {
            set_error(error, error_size, "location_mode must be any or allowlist");
            cJSON_Delete(root);
            return false;
        }
        loaded.location_allowlist_enabled = strcmp(item->valuestring, "allowlist") == 0;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "allowed_locations");
    if ((item != NULL) && !load_location_array(item, &loaded)) {
        set_error(error, error_size, "allowed_locations must be a bounded string array");
        cJSON_Delete(root);
        return false;
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "unknown_location_serviceable");
    if (item != NULL) {
        if (!cJSON_IsBool(item)) {
            set_error(error, error_size, "unknown_location_serviceable must be boolean");
            cJSON_Delete(root);
            return false;
        }
        loaded.unknown_location_serviceable = cJSON_IsTrue(item);
    }

#define LOAD_KEYWORDS(field_name, destination, count_field)                                      \
    item = cJSON_GetObjectItemCaseSensitive(root, field_name);                                   \
    if ((item != NULL) && !load_string_array(item, loaded.destination, CONFIG_MAX_KEYWORDS,       \
                                              &loaded.count_field)) {                              \
        set_error(error, error_size, field_name " must be a bounded string array");              \
        cJSON_Delete(root);                                                                        \
        return false;                                                                              \
    }
    LOAD_KEYWORDS("high_priority_keywords", high_priority_keywords, high_priority_keyword_count)
    LOAD_KEYWORDS("low_priority_keywords", low_priority_keywords, low_priority_keyword_count)
    LOAD_KEYWORDS("spam_keywords", spam_keywords, spam_keyword_count)
    LOAD_KEYWORDS("out_of_scope_keywords", out_of_scope_keywords, out_of_scope_keyword_count)
#undef LOAD_KEYWORDS

    item = cJSON_GetObjectItemCaseSensitive(root, "minimum_detail_words");
    if (item != NULL) {
        if (!json_number_is_integer_in_range(item, 1.0, 100.0)) {
            set_error(error, error_size, "minimum_detail_words must be between 1 and 100");
            cJSON_Delete(root);
            return false;
        }
        loaded.minimum_detail_words = (unsigned int)item->valueint;
    }
    if (loaded.location_allowlist_enabled && (loaded.allowed_location_count == 0U) &&
        !loaded.unknown_location_serviceable) {
        set_error(error, error_size, "allowlist mode requires a location or an explicit unknown-location default");
        cJSON_Delete(root);
        return false;
    }

    *config = loaded;
    cJSON_Delete(root);
    return true;
}
