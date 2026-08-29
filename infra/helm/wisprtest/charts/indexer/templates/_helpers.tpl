{{- define "indexer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "indexer.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name (include "indexer.name" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "indexer.labels" -}}
app.kubernetes.io/name: {{ include "indexer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: indexer
app.kubernetes.io/part-of: wisprtest
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "indexer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "indexer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
