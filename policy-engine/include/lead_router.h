#ifndef LEAD_PROCESSOR_LEAD_ROUTER_H
#define LEAD_PROCESSOR_LEAD_ROUTER_H

#include "config.h"
#include "lead.h"

typedef enum {
    ROUTE_SPAM = 0,
    ROUTE_UNSUPPORTED,
    ROUTE_INSUFFICIENT_INFORMATION,
    ROUTE_STANDARD,
    ROUTE_SPECIALIST,
    ROUTE_URGENT,
    ROUTE_LOCATION_REVIEW,
    ROUTE_MANUAL_REVIEW
} LeadRoute;

LeadRoute lead_route_pre_policy(const Lead *lead, const LeadConfig *config);
LeadRoute lead_route_final(const Lead *lead, const LeadConfig *config, const LeadResult *result);
const char *lead_route_name(LeadRoute route);

#endif
