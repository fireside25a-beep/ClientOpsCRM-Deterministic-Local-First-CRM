#include "lead_rules.h"

#include <ctype.h>
#include <string.h>

static void ascii_lower_copy(char *destination, size_t destination_size, const char *source) {
    size_t i = 0U;
    if ((destination == NULL) || (destination_size == 0U)) {
        return;
    }
    if (source == NULL) {
        destination[0] = '\0';
        return;
    }
    for (i = 0U; (source[i] != '\0') && (i + 1U < destination_size); ++i) {
        unsigned char ch = (unsigned char)source[i];
        if ((ch >= 'A') && (ch <= 'Z')) {
            ch = (unsigned char)(ch + ('a' - 'A'));
        }
        destination[i] = (char)ch;
    }
    destination[i] = '\0';
}

static bool contains_ci(const char *text, const char *needle) {
    char lower_text[LEAD_MESSAGE_MAX];
    char lower_needle[LEAD_CITY_MAX];
    if ((text == NULL) || (needle == NULL) || (needle[0] == '\0')) {
        return false;
    }
    ascii_lower_copy(lower_text, sizeof(lower_text), text);
    ascii_lower_copy(lower_needle, sizeof(lower_needle), needle);
    return strstr(lower_text, lower_needle) != NULL;
}

static bool contains_any(const char *message,
                         const char keywords[][CONFIG_KEYWORD_MAX], size_t count) {
    size_t i = 0U;
    if ((message == NULL) || (keywords == NULL)) {
        return false;
    }
    for (i = 0U; i < count; ++i) {
        if (contains_ci(message, keywords[i])) {
            return true;
        }
    }
    return false;
}

size_t lead_rules_count_words(const char *message) {
    size_t words = 0U;
    bool in_word = false;
    const unsigned char *cursor = (const unsigned char *)message;
    if (message == NULL) {
        return 0U;
    }
    while (*cursor != '\0') {
        const bool alphanumeric = isalnum(*cursor) != 0;
        if (alphanumeric && !in_word) {
            ++words;
        }
        in_word = alphanumeric;
        ++cursor;
    }
    return words;
}

bool lead_rules_is_spam(const char *message, const LeadConfig *config) {
    if (config == NULL) {
        return false;
    }
    return contains_any(message, config->spam_keywords, config->spam_keyword_count);
}

bool lead_rules_is_insufficient(const char *message, const LeadConfig *config) {
    if ((message == NULL) || (config == NULL)) {
        return true;
    }
    return lead_rules_count_words(message) < config->minimum_detail_words;
}

bool lead_rules_is_out_of_scope(const char *message, const LeadConfig *config) {
    if (config == NULL) {
        return false;
    }
    return contains_any(message, config->out_of_scope_keywords,
                        config->out_of_scope_keyword_count);
}

static bool text_equals_ci(const char *left, const char *right) {
    char normalized_left[LEAD_CITY_MAX];
    char normalized_right[LEAD_CITY_MAX];
    ascii_lower_copy(normalized_left, sizeof(normalized_left), left);
    ascii_lower_copy(normalized_right, sizeof(normalized_right), right);
    return strcmp(normalized_left, normalized_right) == 0;
}

bool lead_rules_is_serviceable(const Lead *lead, const LeadConfig *config) {
    size_t i = 0U;
    if ((lead == NULL) || (config == NULL)) {
        return false;
    }
    if (!config->location_allowlist_enabled) {
        return true;
    }
    if (lead->city[0] != '\0') {
        for (i = 0U; i < config->allowed_location_count; ++i) {
            if (text_equals_ci(lead->city, config->allowed_locations[i])) {
                return true;
            }
        }
        return false;
    }
    for (i = 0U; i < config->allowed_location_count; ++i) {
        if (contains_ci(lead->message, config->allowed_locations[i])) {
            return true;
        }
    }
    return config->unknown_location_serviceable;
}

static void infer_category(const char *message, const LeadConfig *config, LeadResult *result) {
    size_t i = 0U;
    size_t matches = 0U;
    const CategoryRule *matched = NULL;
    if ((message == NULL) || (config == NULL) || (result == NULL)) {
        return;
    }
    for (i = 0U; i < config->category_count; ++i) {
        const CategoryRule *candidate = &config->categories[i];
        if (contains_any(message, candidate->keywords, candidate->keyword_count)) {
            ++matches;
            matched = candidate;
        }
    }
    if (matches > 1U) {
        result->category_ambiguous = true;
        result->specialist = false;
        (void)lead_copy_string(result->category, sizeof(result->category), "ambiguous");
    } else if ((matches == 1U) && (matched != NULL)) {
        result->specialist = matched->specialist;
        (void)lead_copy_string(result->category, sizeof(result->category), matched->name);
    } else if (config->fallback_category[0] != '\0') {
        result->specialist = false;
        (void)lead_copy_string(result->category, sizeof(result->category),
                               config->fallback_category);
    } else {
        result->fit = false;
        result->specialist = false;
        (void)lead_copy_string(result->category, sizeof(result->category), "unsupported");
    }
}

unsigned int lead_rules_calculate_score(const Lead *lead, const LeadConfig *config,
                                        const LeadResult *result) {
    unsigned int score = 20U;
    size_t words = 0U;
    if ((lead == NULL) || (config == NULL) || (result == NULL) || !result->fit) {
        return 0U;
    }
    words = lead_rules_count_words(lead->message);
    if (lead->email[0] != '\0') score += 15U;
    if (lead->phone[0] != '\0') score += 10U;
    if (lead->source[0] != '\0') score += 5U;
    if (words >= config->minimum_detail_words) score += 10U;
    if (words >= 8U) score += 10U;
    if (words >= 16U) score += 10U;
    if ((strcmp(result->category, "general") != 0) && !result->category_ambiguous) score += 15U;
    if (strcmp(result->urgency, "high") == 0) score += 10U;
    if ((strcmp(result->urgency, "low") == 0) && (score >= 5U)) score -= 5U;
    if (score > 100U) score = 100U;
    return score;
}

void lead_rules_apply(const Lead *lead, const LeadConfig *config, LeadResult *result) {
    bool low_priority = false;
    if ((lead == NULL) || (config == NULL) || (result == NULL)) {
        return;
    }

    result->fit = true;
    result->serviceable = lead_rules_is_serviceable(lead, config);
    low_priority = contains_any(lead->message, config->low_priority_keywords,
                                config->low_priority_keyword_count);
    if (low_priority) {
        (void)lead_copy_string(result->urgency, sizeof(result->urgency), "low");
    } else if (contains_any(lead->message, config->high_priority_keywords,
                            config->high_priority_keyword_count)) {
        (void)lead_copy_string(result->urgency, sizeof(result->urgency), "high");
    } else {
        (void)lead_copy_string(result->urgency, sizeof(result->urgency), "medium");
    }

    if (lead_rules_is_spam(lead->message, config)) {
        result->fit = false;
        (void)lead_copy_string(result->category, sizeof(result->category), "spam");
        return;
    }
    if (lead_rules_is_insufficient(lead->message, config)) {
        result->fit = false;
        (void)lead_copy_string(result->category, sizeof(result->category), "unknown");
        return;
    }
    if (lead_rules_is_out_of_scope(lead->message, config)) {
        result->fit = false;
        (void)lead_copy_string(result->category, sizeof(result->category), "unsupported");
        return;
    }

    infer_category(lead->message, config, result);
    result->score = lead_rules_calculate_score(lead, config, result);
}
