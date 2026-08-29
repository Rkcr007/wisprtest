{{- define "composer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "composer.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "composer.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "composer.labels" -}}
app.kubernetes.io/name: {{ include "composer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: composer
app.kubernetes.io/part-of: wisprtest
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "composer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "composer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
