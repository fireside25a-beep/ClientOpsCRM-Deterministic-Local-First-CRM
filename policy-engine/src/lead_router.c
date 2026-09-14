#include "lead_router.h"
#include "lead_rules.h"

#include <string.h>

LeadRoute lead_route_pre_policy(const Lead *lead, const LeadConfig *config) {
    if ((lead == NULL) || (config == NULL)) {
        return ROUTE_MANUAL_REVIEW;
    }
    if (lead_rules_is_spam(lead->message, config)) {
        return ROUTE_SPAM;
    }
    if (lead_rules_is_insufficient(lead->message, config)) {
        return ROUTE_INSUFFICIENT_INFORMATION;
    }
    if (lead_rules_is_out_of_scope(lead->message, config)) {
        return ROUTE_UNSUPPORTED;
    }
    return ROUTE_STANDARD;
}

LeadRoute lead_route_final(const Lead *lead, const LeadConfig *config,
                           const LeadResult *result) {
    const LeadRoute preliminary = lead_route_pre_policy(lead, config);
    if ((preliminary == ROUTE_SPAM) ||
        (preliminary == ROUTE_INSUFFICIENT_INFORMATION) ||
        (preliminary == ROUTE_UNSUPPORTED)) {
        return preliminary;
    }
    if (result == NULL) {
        return ROUTE_MANUAL_REVIEW;
    }
    if (!result->fit) {
        return ROUTE_UNSUPPORTED;
    }
    if (result->category_ambiguous) {
        return ROUTE_MANUAL_REVIEW;
    }
    if (!result->serviceable) {
        return ROUTE_LOCATION_REVIEW;
    }
    if (strcmp(result->urgency, "high") == 0) {
        return ROUTE_URGENT;
    }
    if (result->specialist) {
        return ROUTE_SPECIALIST;
    }
    return ROUTE_STANDARD;
}

const char *lead_route_name(LeadRoute route) {
    switch (route) {
        case ROUTE_SPAM: return "ROUTE_SPAM";
        case ROUTE_UNSUPPORTED: return "ROUTE_UNSUPPORTED";
        case ROUTE_INSUFFICIENT_INFORMATION: return "ROUTE_INSUFFICIENT_INFORMATION";
        case ROUTE_STANDARD: return "ROUTE_STANDARD";
        case ROUTE_SPECIALIST: return "ROUTE_SPECIALIST";
        case ROUTE_URGENT: return "ROUTE_URGENT";
        case ROUTE_LOCATION_REVIEW: return "ROUTE_LOCATION_REVIEW";
        case ROUTE_MANUAL_REVIEW: return "ROUTE_MANUAL_REVIEW";
        default: return "ROUTE_MANUAL_REVIEW";
    }
}
