#ifndef LEAD_PROCESSOR_CONFIG_H
#define LEAD_PROCESSOR_CONFIG_H

#include "lead.h"

#include <stdbool.h>
#include <stddef.h>

#define CONFIG_MAX_CATEGORIES 16U
#define CONFIG_MAX_CATEGORY_KEYWORDS 32U
#define CONFIG_MAX_KEYWORDS 64U
#define CONFIG_KEYWORD_MAX 96U

typedef struct {
    char name[LEAD_CATEGORY_MAX];
    char keywords[CONFIG_MAX_CATEGORY_KEYWORDS][CONFIG_KEYWORD_MAX];
    size_t keyword_count;
    bool specialist;
} CategoryRule;

typedef struct {
    CategoryRule categories[CONFIG_MAX_CATEGORIES];
    size_t category_count;
    char fallback_category[LEAD_CATEGORY_MAX];
    bool location_allowlist_enabled;
    char allowed_locations[CONFIG_MAX_KEYWORDS][LEAD_CITY_MAX];
    size_t allowed_location_count;
    bool unknown_location_serviceable;
    char high_priority_keywords[CONFIG_MAX_KEYWORDS][CONFIG_KEYWORD_MAX];
    size_t high_priority_keyword_count;
    char low_priority_keywords[CONFIG_MAX_KEYWORDS][CONFIG_KEYWORD_MAX];
    size_t low_priority_keyword_count;
    char spam_keywords[CONFIG_MAX_KEYWORDS][CONFIG_KEYWORD_MAX];
    size_t spam_keyword_count;
    char out_of_scope_keywords[CONFIG_MAX_KEYWORDS][CONFIG_KEYWORD_MAX];
    size_t out_of_scope_keyword_count;
    unsigned int minimum_detail_words;
} LeadConfig;

void lead_config_defaults(LeadConfig *config);
bool lead_config_load_json(const char *path, LeadConfig *config, char *error, size_t error_size);

#endif
