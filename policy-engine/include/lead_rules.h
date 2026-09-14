#ifndef LEAD_PROCESSOR_LEAD_RULES_H
#define LEAD_PROCESSOR_LEAD_RULES_H

#include "config.h"
#include "lead.h"

#include <stdbool.h>
#include <stddef.h>

void lead_rules_apply(const Lead *lead, const LeadConfig *config, LeadResult *result);
bool lead_rules_is_spam(const char *message, const LeadConfig *config);
bool lead_rules_is_insufficient(const char *message, const LeadConfig *config);
bool lead_rules_is_out_of_scope(const char *message, const LeadConfig *config);
bool lead_rules_is_serviceable(const Lead *lead, const LeadConfig *config);
size_t lead_rules_count_words(const char *message);
unsigned int lead_rules_calculate_score(const Lead *lead, const LeadConfig *config,
                                        const LeadResult *result);

#endif
